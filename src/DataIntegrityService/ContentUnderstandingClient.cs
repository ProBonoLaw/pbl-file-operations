using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Azure.Core;
using Azure.Identity;
using DaatPhoenix.DataIntegrity.AI.DataIntegrity.Exceptions;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

public sealed record CuSourceSnapshot(string ContainerName, string ContainerPath, string SourceSha256,
    string ETag, string OwnerId, string? Snapshot = null);
public sealed record CuOperation(string Phase, string? Operation = null, JsonElement? Response = null,
    CuSourceSnapshot? Source = null);
public interface ICuOperationStore
{
    Task<CuOperation?> ReadAsync(CancellationToken cancellationToken);
    Task SaveAsync(CuOperation operation, CancellationToken cancellationToken);
}

public sealed class ContentUnderstandingClient
{
    private readonly HttpClient http;
    private readonly TokenCredential credential;
    private readonly ContentUnderstandingOptions options;

    public ContentUnderstandingClient(HttpClient http, ContentUnderstandingOptions options)
        : this(http, options, new DefaultAzureCredential()) { }
    public ContentUnderstandingClient(HttpClient http, ContentUnderstandingOptions options, TokenCredential credential)
    {
        this.http = http; this.options = options; this.credential = credential;
    }

    public async Task<JsonElement> AnalyzeAsync(string analyzer, string sourceUrl,
        ICuOperationStore store, CancellationToken cancellationToken, ContentUnderstandingInput? privateInput = null)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(analyzer, @"^[a-zA-Z0-9._-]{1,64}$"))
            throw new InvalidOperationException("Invalid CU analyzer ID.");
        var journal = await store.ReadAsync(cancellationToken);
        if (journal?.Phase == "succeeded") return journal.Response!.Value;
        if (journal?.Phase is "submitting" or "failed")
            throw new InvalidOperationException("Previous CU submission failed or has an unknown outcome. Inspect the saved operation before choosing a new configuration version.");
        if (journal is null || journal.Phase == "prepared")
        {
            // Verify details before spending on analysis. Never mutate a prebuilt analyzer.
            using var definitionResponse = await SendAsync(HttpMethod.Get, Url($"analyzers/{analyzer}"), null, cancellationToken);
            var definition = await JsonAsync(definitionResponse, cancellationToken);
            if (!definition.GetProperty("config").TryGetProperty("returnDetails", out var details) || !details.GetBoolean())
                throw new InvalidOperationException("The selected CU analyzer must enable returnDetails for source citations.");
            object? mappings = options.ModelDeployments is { Length: > 0 } ? JsonSerializer.Deserialize<JsonElement>(options.ModelDeployments) : null;
            var body = new Dictionary<string, object?> { ["inputs"] = new[] { new { url = sourceUrl } } };
            if (mappings is not null) body["modelDeployments"] = mappings;
            journal = (journal ?? new("prepared")) with { Phase = "submitting" };
            await store.SaveAsync(journal, cancellationToken);
            HttpResponseMessage submission;
            try
            {
                submission = await SendAsync(HttpMethod.Post,
                    Url($"analyzers/{analyzer}:analyze", $"&stringEncoding=utf16&processingLocation={options.ProcessingLocation}"),
                    privateInput is null ? JsonSerializer.Serialize(body) : null, cancellationToken,
                    upload: privateInput?.CreateContent(options.ModelDeployments));
            }
            // A server error or request timeout can follow an accepted POST. Keep its snapshot and unknown-outcome journal.
            catch (HttpRequestException error) when ((int?)error.StatusCode is >= 400 and < 500 and not 408)
            {
                await store.SaveAsync(journal with { Phase = "failed" }, cancellationToken);
                throw;
            }
            using var response = submission;
            if (!response.Headers.TryGetValues("Operation-Location", out var values))
                throw new InvalidDataException("CU accepted analysis without an Operation-Location.");
            var operation = ValidateOperation(values.Single());
            journal = journal with { Phase = "polling", Operation = operation.AbsoluteUri };
            await store.SaveAsync(journal, cancellationToken);
        }
        var deadline = DateTimeOffset.UtcNow + options.Timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            var (refreshed, delay) = await RefreshAsync(journal, cancellationToken);
            journal = refreshed;
            if (journal.Phase == "succeeded")
            {
                await store.SaveAsync(journal, cancellationToken);
                return journal.Response!.Value;
            }
            if (journal.Phase == "failed")
            {
                await store.SaveAsync(journal, cancellationToken);
                throw new UnprocessableDocumentException("CU analysis failed. Its response is retained in the operation journal.");
            }
            await Task.Delay(delay, cancellationToken);
        }
        throw new TimeoutException("CU polling timed out. Retry resumes the saved operation without resubmitting.");
    }

    public async Task<(CuOperation Operation, TimeSpan RetryDelay)> RefreshAsync(CuOperation journal, CancellationToken cancellationToken)
    {
        if (journal.Phase != "polling") throw new InvalidOperationException("Only a polling CU operation can be refreshed.");
        using var response = await SendAsync(HttpMethod.Get, ValidateOperation(journal.Operation!), null, cancellationToken);
        var result = await JsonAsync(response, cancellationToken);
        string? state = result.GetProperty("status").GetString()?.ToLowerInvariant();
        var refreshed = state switch
        {
            "succeeded" => journal with { Phase = "succeeded", Response = result },
            "failed" or "canceled" or "cancelled" => journal with { Phase = "failed", Response = result },
            "running" or "notstarted" => journal,
            _ => throw new InvalidDataException("Unknown CU operation status.")
        };
        return (refreshed, RetryDelay(response, TimeSpan.FromSeconds(3)));
    }

    public Uri ValidateOperation(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "https" ||
            uri.Authority != options.Endpoint.Authority || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0 ||
            !System.Text.RegularExpressions.Regex.IsMatch(uri.AbsolutePath, @"^/contentunderstanding/analyzerResults/[a-zA-Z0-9._-]+$"))
            throw new InvalidDataException("CU operation URL does not belong to the configured endpoint.");
        return uri;
    }

    public async Task<(byte[] Bytes, string ContentType)> GetImageAsync(string operation, string path,
        CancellationToken cancellationToken)
    {
        var operationUri = ValidateOperation(operation);
        if (!System.Text.RegularExpressions.Regex.IsMatch(path, @"^(figures/[a-zA-Z0-9][a-zA-Z0-9._-]*|keyframes/[0-9]+)$"))
            throw new InvalidDataException("Invalid CU image result path.");
        var target = new Uri(options.Endpoint,
            $"{operationUri.AbsolutePath.TrimStart('/')}/files/{path}?api-version={ContentUnderstandingOptions.ApiVersion}");
        using var response = await SendAsync(HttpMethod.Get, target, null, cancellationToken, headersOnly: true);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(60));
        cancellationToken = deadline.Token;
        const int maximumBytes = 25 * 1024 * 1024;
        if (response.Content.Headers.ContentLength > maximumBytes) throw new InvalidDataException("CU image exceeds 25 MB.");
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var output = new MemoryStream();
        var buffer = new byte[64 * 1024];
        int count;
        while ((count = await input.ReadAsync(buffer, cancellationToken)) > 0)
        {
            if (output.Length + count > maximumBytes) throw new InvalidDataException("CU image exceeds 25 MB.");
            await output.WriteAsync(buffer.AsMemory(0, count), cancellationToken);
        }
        var bytes = output.ToArray();
        string contentType = bytes.AsSpan().StartsWith(new byte[] { 0xff, 0xd8, 0xff }) ? "image/jpeg"
            : bytes.AsSpan().StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) ? "image/png"
            : bytes.AsSpan().StartsWith("GIF87a"u8) || bytes.AsSpan().StartsWith("GIF89a"u8) ? "image/gif"
            : bytes.Length >= 12 && bytes.AsSpan(0, 4).SequenceEqual("RIFF"u8) && bytes.AsSpan(8, 4).SequenceEqual("WEBP"u8) ? "image/webp"
            : throw new InvalidDataException("CU result file is not a supported raster image.");
        return (bytes, contentType);
    }

    private Uri Url(string path, string query = "") => new(options.Endpoint,
        $"contentunderstanding/{path}?api-version={ContentUnderstandingOptions.ApiVersion}{query}");

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, Uri uri, string? body, CancellationToken cancellationToken,
        bool headersOnly = false, HttpContent? upload = null)
    {
        for (int attempt = 0; ; attempt++)
        {
            using var request = new HttpRequestMessage(method, uri);
            if (body is not null) request.Content = new StringContent(body, Encoding.UTF8, "application/json");
            if (upload is not null) request.Content = upload;
            if (!string.IsNullOrEmpty(options.ApiKey)) request.Headers.Add("Ocp-Apim-Subscription-Key", options.ApiKey);
            else request.Headers.Authorization = new AuthenticationHeaderValue("Bearer",
                (await credential.GetTokenAsync(new TokenRequestContext(["https://cognitiveservices.azure.com/.default"]), cancellationToken)).Token);
            request.Headers.Add("x-ms-diagnostics", "true");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(upload is null ? TimeSpan.FromSeconds(60) : TimeSpan.FromMinutes(30));
            var response = await http.SendAsync(request, headersOnly ? HttpCompletionOption.ResponseHeadersRead : HttpCompletionOption.ResponseContentRead, timeout.Token);
            if (response.IsSuccessStatusCode) return response;
            if (method == HttpMethod.Get && attempt < 2 && response.StatusCode is
                HttpStatusCode.TooManyRequests or HttpStatusCode.InternalServerError or HttpStatusCode.BadGateway or
                HttpStatusCode.ServiceUnavailable or HttpStatusCode.GatewayTimeout)
            {
                var delay = RetryDelay(response, TimeSpan.FromSeconds(2));
                response.Dispose();
                await Task.Delay(delay, cancellationToken);
                continue;
            }
            var status = (int)response.StatusCode;
            response.Dispose();
            throw new HttpRequestException($"CU request returned HTTP {status}.", null, (HttpStatusCode)status);
        }
    }
    private static TimeSpan RetryDelay(HttpResponseMessage response, TimeSpan fallback)
    {
        var delay = response.Headers.RetryAfter?.Delta ??
            (response.Headers.RetryAfter?.Date is { } date ? date - DateTimeOffset.UtcNow : fallback);
        return TimeSpan.FromMilliseconds(Math.Clamp(delay.TotalMilliseconds, 100, 30_000));
    }
    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        return json.RootElement.Clone();
    }
}
