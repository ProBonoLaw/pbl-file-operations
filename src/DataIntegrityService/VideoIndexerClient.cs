using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Azure.Core;
using Azure.Identity;
using Azure.Storage.Blobs;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DataIntegrity.AI.DataIntegrity.Exceptions;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration
{
	/// <summary>
	/// Calls Azure AI Video Indexer using an account-scoped access token generated
	/// through Azure Resource Manager. The video itself stays in Blob Storage and
	/// Video Indexer's managed identity downloads it from there.
	/// </summary>
	public class VideoIndexerClient
	{
		private const string ManagementScope = "https://management.azure.com/.default";
		private static readonly TimeSpan AccountTokenRefreshBuffer = TimeSpan.FromMinutes(5);
		private static readonly TimeSpan AccountTokenFallbackLifetime = TimeSpan.FromMinutes(30);
		private static readonly ConcurrentDictionary<string, CachedAccountToken> AccountTokenCache = new();
		private static readonly ConcurrentDictionary<string, SemaphoreSlim> AccountTokenRefreshLocks = new();
		private readonly HttpClient httpClient;
		private readonly BlobServiceClient blobServiceClient;
		private readonly TokenCredential credential;
		private readonly IConfiguration configuration;
		private readonly ILogger<VideoIndexerClient> logger;

		public VideoIndexerClient(
			HttpClient httpClient,
			BlobServiceClient blobServiceClient,
			IConfiguration configuration,
			ILogger<VideoIndexerClient> logger)
			: this(httpClient, blobServiceClient, new DefaultAzureCredential(), configuration, logger)
		{
		}

		internal VideoIndexerClient(
			HttpClient httpClient,
			BlobServiceClient blobServiceClient,
			TokenCredential credential,
			IConfiguration configuration,
			ILogger<VideoIndexerClient> logger)
		{
			this.httpClient = httpClient;
			this.blobServiceClient = blobServiceClient;
			this.credential = credential;
			this.configuration = configuration;
			this.logger = logger;
		}

		public async Task<VideoIndexerJob> SubmitAsync(
			VideoIndexerInput input,
			CancellationToken cancellationToken = default)
		{
			var configuration = VideoIndexerConfiguration.Read(this.configuration);
			var blobClient = blobServiceClient
				.GetBlobContainerClient(input.Container)
				.GetBlobClient(input.FilePath);
			if (!await blobClient.ExistsAsync(cancellationToken))
			{
				throw new UnprocessableDocumentException($"{input.MediaType} source was not found in Blob Storage.");
			}

			string accessToken = await GetAccountAccessTokenAsync(configuration, cancellationToken);
			string externalId = CreateExternalId(input);
			string videoId;
			try
			{
				videoId = await SubmitVideoAsync(
					configuration,
					accessToken,
					blobClient.Uri.AbsoluteUri,
					input.Filename,
					externalId,
					input.HighRes ? "Advanced" : configuration.IndexingPreset,
					cancellationToken);
			}
			catch (VideoAlreadyIndexedException)
			{
				string? existingVideoId = await FindExistingVideoIdAsync(
					configuration,
					accessToken,
					externalId,
					input.Filename,
					cancellationToken);
				if (string.IsNullOrWhiteSpace(existingVideoId))
				{
					throw new UnprocessableDocumentException(
						"Video Indexer reported that the video already exists, but no matching video could be found.");
				}
				logger.LogInformation("Reusing existing Video Indexer video {VideoId} for {FileName}.", existingVideoId, input.Filename);
				videoId = existingVideoId;
			}
			return new VideoIndexerJob(videoId);
		}

		internal async Task<VideoIndexerIndexResult> GetIndexAsync(
			VideoIndexerPollInput input,
			CancellationToken cancellationToken = default)
		{
			var configuration = VideoIndexerConfiguration.Read(this.configuration);
			string accessToken = await GetAccountAccessTokenAsync(configuration, cancellationToken);
			string endpoint = ApiUrl(
				configuration,
				$"Videos/{Uri.EscapeDataString(input.VideoId)}/Index",
				new Dictionary<string, string?>());
			using var request = VideoIndexerRequest(HttpMethod.Get, endpoint, accessToken);
			using var response = await httpClient.SendAsync(request, cancellationToken);
			string body = await response.Content.ReadAsStringAsync(cancellationToken);
			if (!response.IsSuccessStatusCode)
			{
				ThrowIfTransientFailure(response, "Video Indexer status check");
				throw new UnprocessableDocumentException(
					$"Video Indexer status check failed (HTTP {(int)response.StatusCode}).");
			}

			using var index = JsonDocument.Parse(body);
			string state = index.RootElement.TryGetProperty("state", out JsonElement stateElement)
				? stateElement.GetString() ?? "Unknown"
				: "Unknown";
			return string.Equals(state, "Processed", StringComparison.OrdinalIgnoreCase)
				? new VideoIndexerIndexResult(state, VideoInsightsMarkdownGenerator.Generate(index.RootElement, input.Source))
				: new VideoIndexerIndexResult(state);
		}

		private async Task<string> GetAccountAccessTokenAsync(
			VideoIndexerConfiguration configuration,
			CancellationToken cancellationToken)
		{
			if (!string.IsNullOrWhiteSpace(configuration.AccessToken))
			{
				return configuration.AccessToken;
			}
			string cacheKey = AccountTokenCacheKey(configuration);
			if (TryGetCachedAccountToken(cacheKey, out string cachedToken))
			{
				return cachedToken;
			}

			SemaphoreSlim refreshLock = AccountTokenRefreshLocks.GetOrAdd(cacheKey, _ => new SemaphoreSlim(1, 1));
			await refreshLock.WaitAsync(cancellationToken);
			try
			{
				if (TryGetCachedAccountToken(cacheKey, out cachedToken))
				{
					return cachedToken;
				}

				string accountToken = await GenerateAccountAccessTokenAsync(configuration, cancellationToken);
				AccountTokenCache[cacheKey] = new CachedAccountToken(
					accountToken,
					AccountTokenRefreshAt(accountToken));
				return accountToken;
			}
			finally
			{
				refreshLock.Release();
			}
		}

		private async Task<string> GenerateAccountAccessTokenAsync(
			VideoIndexerConfiguration configuration,
			CancellationToken cancellationToken)
		{
			AccessToken armToken = await credential.GetTokenAsync(
				new TokenRequestContext(new[] { ManagementScope }),
				cancellationToken);
			string resource =
				$"https://management.azure.com/subscriptions/{Uri.EscapeDataString(configuration.SubscriptionId)}" +
				$"/resourceGroups/{Uri.EscapeDataString(configuration.ResourceGroup)}" +
				$"/providers/Microsoft.VideoIndexer/accounts/{Uri.EscapeDataString(configuration.AccountName)}" +
				$"/generateAccessToken?api-version={Uri.EscapeDataString(configuration.ArmApiVersion)}";
			using var request = new HttpRequestMessage(HttpMethod.Post, resource)
			{
				Content = new StringContent(
					"{\"permissionType\":\"Contributor\",\"scope\":\"Account\"}",
					Encoding.UTF8,
					"application/json"),
			};
			request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", armToken.Token);
			using HttpResponseMessage response = await httpClient.SendAsync(request, cancellationToken);
			string body = await response.Content.ReadAsStringAsync(cancellationToken);
			if (!response.IsSuccessStatusCode)
			{
				ThrowIfTransientFailure(response, "Video Indexer account token request");
				throw new UnprocessableDocumentException(
					$"Unable to obtain a Video Indexer account access token (HTTP {(int)response.StatusCode}).");
			}

			using var tokenDocument = JsonDocument.Parse(body);
			if (!tokenDocument.RootElement.TryGetProperty("accessToken", out JsonElement token)
				|| string.IsNullOrWhiteSpace(token.GetString()))
			{
				throw new UnprocessableDocumentException("Video Indexer did not return an account access token.");
			}
			return token.GetString()!;
		}

		private static bool TryGetCachedAccountToken(string cacheKey, out string token)
		{
			if (AccountTokenCache.TryGetValue(cacheKey, out CachedAccountToken? cached)
				&& cached.RefreshAfter > DateTimeOffset.UtcNow)
			{
				token = cached.Token;
				return true;
			}
			token = string.Empty;
			return false;
		}

		private static string AccountTokenCacheKey(VideoIndexerConfiguration configuration) =>
			$"{configuration.SubscriptionId}|{configuration.ResourceGroup}|{configuration.AccountName}|{configuration.AccountId}";

		private static DateTimeOffset AccountTokenRefreshAt(string token)
		{
			DateTimeOffset now = DateTimeOffset.UtcNow;
			DateTimeOffset? expiresAt = JwtExpiry(token);
			if (expiresAt is not null && expiresAt > now + AccountTokenRefreshBuffer)
			{
				return expiresAt.Value - AccountTokenRefreshBuffer;
			}
			return now + AccountTokenFallbackLifetime;
		}

		private static DateTimeOffset? JwtExpiry(string token)
		{
			string[] parts = token.Split('.');
			if (parts.Length < 2)
			{
				return null;
			}
			try
			{
				string payload = parts[1].Replace('-', '+').Replace('_', '/');
				payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
				using var document = JsonDocument.Parse(Convert.FromBase64String(payload));
				if (document.RootElement.TryGetProperty("exp", out JsonElement expiry)
					&& expiry.TryGetInt64(out long unixSeconds))
				{
					return DateTimeOffset.FromUnixTimeSeconds(unixSeconds);
				}
			}
			catch (FormatException)
			{
				// The token format is opaque to this client; use the conservative fallback lifetime.
			}
			catch (JsonException)
			{
				// The token format is opaque to this client; use the conservative fallback lifetime.
			}
			catch (ArgumentOutOfRangeException)
			{
				// The token format is opaque to this client; use the conservative fallback lifetime.
			}
			return null;
		}

		private async Task<string> SubmitVideoAsync(
			VideoIndexerConfiguration configuration,
			string accessToken,
			string blobUrl,
			string filename,
			string externalId,
			string indexingPreset,
			CancellationToken cancellationToken)
		{
			string endpoint = ApiUrl(
				configuration,
				"Videos",
				new Dictionary<string, string?>
				{
					["name"] = filename,
					["externalId"] = externalId,
					["videoUrl"] = blobUrl,
					["privacy"] = "Private",
					["indexingPreset"] = indexingPreset,
					["streamingPreset"] = "Default",
					["useManagedIdentityToDownloadVideo"] = "true",
				});
			using var request = VideoIndexerRequest(HttpMethod.Post, endpoint, accessToken);
			using var response = await httpClient.SendAsync(request, cancellationToken);
			string body = await response.Content.ReadAsStringAsync(cancellationToken);
			if (response.StatusCode == System.Net.HttpStatusCode.Conflict)
			{
				throw new VideoAlreadyIndexedException();
			}
			if (!response.IsSuccessStatusCode)
			{
				ThrowIfTransientFailure(response, "Video Indexer submission");
				throw new UnprocessableDocumentException(
					$"Video Indexer rejected the video submission (HTTP {(int)response.StatusCode}).");
			}

			using var submission = JsonDocument.Parse(body);
			if (!submission.RootElement.TryGetProperty("id", out JsonElement id)
				|| string.IsNullOrWhiteSpace(id.GetString()))
			{
				throw new UnprocessableDocumentException("Video Indexer did not return a video identifier.");
			}
			return id.GetString()!;
		}

		private async Task<string?> FindExistingVideoIdAsync(
			VideoIndexerConfiguration configuration,
			string accessToken,
			string externalId,
			string filename,
			CancellationToken cancellationToken)
		{
			string endpoint = ApiUrl(
				configuration,
				"Videos",
				new Dictionary<string, string?>
				{
					["search"] = filename,
					["pageSize"] = "100",
				});
			using var request = VideoIndexerRequest(HttpMethod.Get, endpoint, accessToken);
			using var response = await httpClient.SendAsync(request, cancellationToken);
			string body = await response.Content.ReadAsStringAsync(cancellationToken);
			if (!response.IsSuccessStatusCode)
			{
				ThrowIfTransientFailure(response, "Video Indexer conflict lookup");
				throw new UnprocessableDocumentException(
					$"Video Indexer conflict lookup failed (HTTP {(int)response.StatusCode}).");
			}

			using var result = JsonDocument.Parse(body);
			JsonElement videos = GetVideos(result.RootElement);
			if (videos.ValueKind != JsonValueKind.Array)
			{
				return null;
			}
			foreach (JsonElement video in videos.EnumerateArray())
			{
				if (!video.TryGetProperty("id", out JsonElement id)
					|| string.IsNullOrWhiteSpace(id.GetString()))
				{
					continue;
				}
				if (video.TryGetProperty("externalId", out JsonElement candidateExternalId)
					&& string.Equals(candidateExternalId.GetString(), externalId, StringComparison.Ordinal))
				{
					return id.GetString();
				}
			}

			return null;
		}

		private static JsonElement GetVideos(JsonElement response)
		{
			if (response.ValueKind == JsonValueKind.Array)
			{
				return response;
			}
			return response.TryGetProperty("results", out JsonElement results)
				&& results.ValueKind == JsonValueKind.Array
				? results
				: default;
		}

		private static string CreateExternalId(VideoIndexerInput input)
		{
			string indexingVariant = input.HighRes ? "|advanced" : string.Empty;
			byte[] sourceBytes = Encoding.UTF8.GetBytes($"{input.AccountId}|{input.SourceId}|{input.FilePath}{indexingVariant}");
			return Convert.ToHexString(SHA256.HashData(sourceBytes)).ToLowerInvariant();
		}

		private static string ApiUrl(
			VideoIndexerConfiguration configuration,
			string path,
			IDictionary<string, string?> parameters)
		{
			// Video Indexer's account-specific hostname is required for Private Link DNS
			// resolution. The shared api.videoindexer.ai hostname always resolves publicly.
			string baseUrl = $"https://{configuration.AccountName}.api.videoindexer.ai/{Uri.EscapeDataString(configuration.Location)}/Accounts/{Uri.EscapeDataString(configuration.AccountId)}/{path}";
			return QueryHelpers.AddQueryString(baseUrl, parameters);
		}

		private static HttpRequestMessage VideoIndexerRequest(HttpMethod method, string endpoint, string accessToken)
		{
			var request = new HttpRequestMessage(method, endpoint);
			request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
			return request;
		}

		private static void ThrowIfTransientFailure(HttpResponseMessage response, string operation)
		{
			int status = (int)response.StatusCode;
			if (status == 429 || status is >= 500 and <= 599)
			{
				throw new TransientVideoIndexerException(operation, response.StatusCode);
			}
		}

		private sealed class VideoAlreadyIndexedException : Exception
		{
		}

		private sealed record CachedAccountToken(string Token, DateTimeOffset RefreshAfter);
	}

	internal sealed class TransientVideoIndexerException : Exception
	{
		public HttpStatusCode StatusCode { get; }

		public TransientVideoIndexerException(string operation, HttpStatusCode statusCode)
			: base($"{operation} failed temporarily (HTTP {(int)statusCode}).")
		{
			StatusCode = statusCode;
		}
	}

	internal sealed record VideoIndexerConfiguration(
		string AccountId,
		string Location,
		string? AccessToken,
		string SubscriptionId,
		string ResourceGroup,
		string AccountName,
		string ArmApiVersion,
		string IndexingPreset)
	{
		public static VideoIndexerConfiguration Read(IConfiguration configuration)
		{
			string accountId = Required(configuration, "VIDEO_INDEXER_ACCOUNT_ID");
			string location = Required(configuration, "VIDEO_INDEXER_LOCATION");
			string accountName = Required(configuration, "VIDEO_INDEXER_ACCOUNT_NAME");
			string? accessToken = configuration["VIDEO_INDEXER_ACCESS_TOKEN"];
			bool hasExplicitAccessToken = !string.IsNullOrWhiteSpace(accessToken);
			string subscriptionId = hasExplicitAccessToken ? string.Empty : Required(configuration, "VIDEO_INDEXER_SUBSCRIPTION_ID");
			string resourceGroup = hasExplicitAccessToken ? string.Empty : Required(configuration, "VIDEO_INDEXER_RESOURCE_GROUP");
			return new VideoIndexerConfiguration(
				accountId,
				location,
				accessToken,
				subscriptionId,
				resourceGroup,
				accountName,
				configuration["VIDEO_INDEXER_ARM_API_VERSION"] ?? "2024-01-01",
				ReadIndexingPreset(configuration["VIDEO_INDEXER_INDEXING_PRESET"]));
		}

		private static string Required(IConfiguration configuration, string name) =>
			configuration[name] is { Length: > 0 } value
				? value
				: throw new InvalidOperationException($"Configuration setting '{name}' is not set.");

		private static string ReadIndexingPreset(string? value)
		{
			string preset = string.IsNullOrWhiteSpace(value) ? "Default" : value.Trim();
			return preset.Equals("Default", StringComparison.OrdinalIgnoreCase)
				|| preset.Equals("Basic", StringComparison.OrdinalIgnoreCase)
				|| preset.Equals("Advanced", StringComparison.OrdinalIgnoreCase)
				? preset
				: throw new InvalidOperationException(
					"Environment variable 'VIDEO_INDEXER_INDEXING_PRESET' must be Default, Basic, or Advanced.");
		}

	}
}
