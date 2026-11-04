using System.Net;
using System.Text;
using System.Text.Json;
using Azure.Core.Pipeline;
using Azure.Storage.Blobs;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace FileOperations.Tests;

public class MarkdownCoverageCacheTests
{
    [Theory]
    [InlineData("document", null, false)]
    [InlineData("document", 0, false)]
    [InlineData("document", 1, true)]
    [InlineData("audio", null, true)]
    public async Task DocumentCacheRequiresCurrentMarkdownCoverageValidation(string media, int? coverageVersion, bool cacheHit)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["INTEGRITY_DOCUMENT_PROVIDER"] = ExtractionPolicy.CuProvider,
            ["INTEGRITY_AUDIO_PROVIDER"] = ExtractionPolicy.CuProvider,
            ["CONTENT_UNDERSTANDING_ENDPOINT"] = "https://example.services.ai.azure.com/"
        }).Build();
        var policy = new ExtractionPolicy(configuration);
        string filename = media == "document" ? "source.pdf" : "source.wav";
        var request = new DocumentRequest(filename, filename, "source", "account");
        string json = JsonSerializer.Serialize(new
        {
            version = 1, accountId = "account", sourceId = "source", mediaType = media,
            configurationHash = policy.CacheIdentity(request), stringEncoding = "utf16", analysisId = "one",
            assets = Array.Empty<object>(), markdownCoverageVersion = coverageVersion
        }, new JsonSerializerOptions { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull });
        using var handler = new CachedPackageHandler(json);
        using var http = new HttpClient(handler);
        var blobs = new BlobServiceClient(new Uri("https://storage.example/"),
            new BlobClientOptions { Transport = new HttpClientTransport(http) });
        var response = await new DataIntegrityFileLookup(blobs, new("results"), policy).FindExistingAsync(request, CancellationToken.None);
        Assert.Equal(cacheHit, response is not null);
        Assert.Equal(3, handler.Reads);
    }

    private sealed class CachedPackageHandler(string json) : HttpMessageHandler
    {
        public int Reads { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.True(request.Method == HttpMethod.Get || request.Method == HttpMethod.Head);
            Reads++;
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
            response.Headers.TryAddWithoutValidation("ETag", "\"version\"");
            response.Headers.TryAddWithoutValidation("x-ms-blob-type", "BlockBlob");
            response.Content.Headers.LastModified = DateTimeOffset.Parse("2026-10-12T00:00:00Z");
            response.Content.Headers.ContentLength = Encoding.UTF8.GetByteCount(json);
            return Task.FromResult(response);
        }
    }
}
