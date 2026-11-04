using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace DaatPhoenix.HttpOrchestration;

public sealed class HttpOrchestrationClient
{
    private static readonly TimeSpan MaximumSupportedDelay =
        TimeSpan.FromMilliseconds(uint.MaxValue - 1d);

    private readonly HttpClient client;
    private readonly ILogger? logger;
    private readonly HttpOrchestrationOptions options;

    public HttpOrchestrationClient(HttpClient client, ILogger? logger = null,
        HttpOrchestrationOptions? options = null)
    {
        this.client = client ?? throw new ArgumentNullException(nameof(client));
        this.logger = logger;
        this.options = options ?? new HttpOrchestrationOptions();
        if (this.options.PollingInterval < TimeSpan.Zero ||
            this.options.MaximumPollingInterval < TimeSpan.Zero ||
            this.options.Timeout <= TimeSpan.Zero ||
            this.options.PollingInterval > MaximumSupportedDelay ||
            this.options.MaximumPollingInterval > MaximumSupportedDelay ||
            this.options.Timeout > MaximumSupportedDelay)
            throw new ArgumentOutOfRangeException(nameof(options),
                $"Polling intervals must be non-negative, timeout must be positive, and all durations must not exceed {MaximumSupportedDelay}");
    }

    public async Task<JsonElement?> SendAndWaitForCompletionAsync(HttpMethod method, Uri endpoint,
        object? payload, string? operationName, IReadOnlyDictionary<string, string>? headers,
        CancellationToken cancellationToken, int retryCount = 1, TimeSpan? retryDelay = null)
    {
        ValidateEndpoint(endpoint);
        var operation = GetOperationName(method, endpoint, operationName);
        var initial = await SendResponseAsync(method, endpoint, payload, operation, headers,
            cancellationToken, retryCount: retryCount, retryDelay: retryDelay);
        Uri? statusUri = null;
        var statusLinkSource = "Location header";
        if (initial.Body is { ValueKind: JsonValueKind.Object } initialBody &&
            initialBody.TryGetProperty("statusQueryGetUri", out var statusValue))
        {
            if (statusValue.ValueKind != JsonValueKind.String ||
                !Uri.TryCreate(statusValue.GetString(), UriKind.RelativeOrAbsolute, out var statusLink))
                throw new InvalidDataException($"Downstream operation {operation} returned an invalid status URL");
            statusUri = ValidateStatusUri(endpoint, statusLink, operation);
            statusLinkSource = "response body";
        }
        else if (initial.Location is not null)
        {
            statusUri = ValidateStatusUri(endpoint, initial.Location, operation);
        }

        if (statusUri is null)
        {
            if (initial.StatusCode == HttpStatusCode.Accepted)
                throw new InvalidDataException(
                    $"Downstream operation {operation} returned HTTP 202 without a statusQueryGetUri or Location header");
            return initial.Body;
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(options.Timeout);
        logger?.LogInformation(
            "Downstream operation {Operation} accepted an asynchronous request; polling the {StatusLinkSource}",
            operation, statusLinkSource);
        string? previousStatus = null;
        try
        {
            while (true)
            {
                using var response = await client.GetAsync(statusUri, timeout.Token);
                response.EnsureSuccessStatusCode();
                var body = await response.Content.ReadAsStringAsync(timeout.Token);
                JsonDocument? document = null;
                if (!string.IsNullOrWhiteSpace(body))
                {
                    try
                    {
                        document = JsonDocument.Parse(body);
                    }
                    catch (JsonException) when (response.StatusCode == HttpStatusCode.Accepted)
                    {
                    }
                }

                using (document)
                {
                    var result = document?.RootElement;
                    JsonElement runtimeStatus = default;
                    var hasRuntimeStatus = result.HasValue &&
                        result.Value.ValueKind == JsonValueKind.Object &&
                        result.Value.TryGetProperty("runtimeStatus", out runtimeStatus);
                    if (hasRuntimeStatus && runtimeStatus.ValueKind != JsonValueKind.String)
                        throw new InvalidDataException(
                            $"Downstream operation {operation} returned an invalid runtime status");

                    string? status = hasRuntimeStatus ? runtimeStatus.GetString() : null;
                    if (status is null && result is { ValueKind: JsonValueKind.Object } statusResult &&
                        statusResult.TryGetProperty("status", out var statusProperty) &&
                        statusProperty.ValueKind == JsonValueKind.String)
                        status = statusProperty.GetString();

                    if (status is null && response.StatusCode != HttpStatusCode.Accepted)
                    {
                        if (result.HasValue) return result.Value.Clone();
                        throw new InvalidDataException(
                            $"Downstream operation {operation} returned an empty status response");
                    }

                    if (status != previousStatus)
                    {
                        logger?.LogInformation("Downstream orchestration {Operation} is {Status}",
                            operation, status ?? $"HTTP {(int)response.StatusCode}");
                        previousStatus = status;
                    }

                    switch (status?.ToLowerInvariant())
                    {
                        case "completed":
                        case "succeeded":
                            return result!.Value.Clone();
                        case "failed":
                        case "terminated":
                        case "canceled":
                        case "cancelled":
                            throw new InvalidDataException(
                                $"Downstream orchestration {operation} ended with {status}");
                        case "pending":
                        case "running":
                        case "continuedasnew":
                        case "accepted":
                        case null when response.StatusCode == HttpStatusCode.Accepted:
                            break;
                        default:
                            if (hasRuntimeStatus)
                                throw new InvalidDataException(
                                    $"Downstream orchestration {operation} returned an unknown status");
                            return result!.Value.Clone();
                    }
                }

                await WaitBeforePollAsync(ReadRetryAfter(response), timeout.Token);
            }
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested &&
            !cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException(
                $"Downstream orchestration {operation} did not complete within {options.Timeout}");
        }
    }

    public async Task<JsonElement?> SendAsync(HttpMethod method, Uri endpoint, object? payload,
        string? operationName, IReadOnlyDictionary<string, string>? headers, CancellationToken cancellationToken,
        bool allowNotFound = false, int retryCount = 1, TimeSpan? retryDelay = null)
    {
        ValidateEndpoint(endpoint);
        var operation = GetOperationName(method, endpoint, operationName);
        var response = await SendResponseAsync(method, endpoint, payload, operation, headers,
            cancellationToken, allowNotFound, retryCount, retryDelay);
        return response.Body;
    }

    private async Task<DownstreamResponse> SendResponseAsync(HttpMethod method, Uri endpoint, object? payload,
        string operation, IReadOnlyDictionary<string, string>? headers, CancellationToken cancellationToken,
        bool allowNotFound = false, int retryCount = 1, TimeSpan? retryDelay = null)
    {
        ArgumentNullException.ThrowIfNull(method);
        if (retryCount < 1) throw new ArgumentOutOfRangeException(nameof(retryCount));
        if (retryDelay is { } delay &&
            (delay < TimeSpan.Zero || delay > MaximumSupportedDelay))
            throw new ArgumentOutOfRangeException(nameof(retryDelay), retryDelay,
                $"Retry delay must be between zero and {MaximumSupportedDelay}");

        for (var attempt = 1; ; attempt++)
        {
            var stopwatch = Stopwatch.StartNew();
            using var request = new HttpRequestMessage(method, endpoint);
            if (payload is not null)
                request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8,
                    "application/json");
            if (headers is not null)
            {
                foreach (var header in headers)
                    request.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }

            try
            {
                using var response = await client.SendAsync(request, cancellationToken);
                if (allowNotFound && response.StatusCode == HttpStatusCode.NotFound)
                {
                    logger?.LogInformation("Downstream operation {Operation} returned not found in {DurationMs} ms",
                        operation, stopwatch.Elapsed.TotalMilliseconds);
                    return new DownstreamResponse(null, response.StatusCode, response.Headers.Location,
                        ReadRetryAfter(response));
                }
                if ((int)response.StatusCode >= 500 || response.StatusCode == HttpStatusCode.TooManyRequests)
                {
                    if (attempt < retryCount)
                    {
                        logger?.LogWarning(
                            "Downstream operation {Operation} returned HTTP {StatusCode} on attempt {Attempt}; retrying",
                            operation, (int)response.StatusCode, attempt);
                        await Task.Delay(retryDelay ?? TimeSpan.FromSeconds(2), cancellationToken);
                        continue;
                    }
                }
                if (!response.IsSuccessStatusCode)
                    logger?.LogWarning("Downstream operation {Operation} returned HTTP {StatusCode}",
                        operation, (int)response.StatusCode);
                response.EnsureSuccessStatusCode();
                logger?.LogInformation(
                    "Downstream request {Operation} returned HTTP {StatusCode} in {DurationMs} ms on attempt {Attempt}",
                    operation, (int)response.StatusCode, stopwatch.Elapsed.TotalMilliseconds, attempt);
                var body = await response.Content.ReadAsStringAsync(cancellationToken);
                if (string.IsNullOrWhiteSpace(body))
                    return new DownstreamResponse(null, response.StatusCode, response.Headers.Location,
                        ReadRetryAfter(response));
                try
                {
                    using var document = JsonDocument.Parse(body);
                    return new DownstreamResponse(document.RootElement.Clone(), response.StatusCode,
                        response.Headers.Location, ReadRetryAfter(response));
                }
                catch (JsonException)
                {
                    return new DownstreamResponse(JsonSerializer.SerializeToElement(body), response.StatusCode,
                        response.Headers.Location, ReadRetryAfter(response));
                }
            }
            catch (HttpRequestException error) when (attempt < retryCount &&
                (error.StatusCode is null || error.StatusCode == HttpStatusCode.TooManyRequests ||
                 (int)error.StatusCode >= 500))
            {
                logger?.LogWarning(error,
                    "Downstream operation {Operation} failed on attempt {Attempt}; retrying", operation, attempt);
                await Task.Delay(retryDelay ?? TimeSpan.FromSeconds(2), cancellationToken);
            }
        }
    }

    private static void ValidateEndpoint(Uri endpoint)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        if (!endpoint.IsAbsoluteUri || (endpoint.Scheme != Uri.UriSchemeHttp && endpoint.Scheme != Uri.UriSchemeHttps))
            throw new ArgumentException("Endpoint must be an absolute HTTP or HTTPS URI", nameof(endpoint));
    }

    private static Uri ValidateStatusUri(Uri source, Uri statusLink, string operation)
    {
        var statusUri = statusLink.IsAbsoluteUri ? statusLink : new Uri(source, statusLink);
        if (source.Scheme != statusUri.Scheme ||
            !string.Equals(source.Host, statusUri.Host, StringComparison.OrdinalIgnoreCase) ||
            source.Port != statusUri.Port)
            throw new InvalidDataException($"Downstream operation {operation} returned an invalid status URL");
        return statusUri;
    }

    private static string GetOperationName(HttpMethod method, Uri endpoint, string? operationName) =>
        string.IsNullOrWhiteSpace(operationName) ? $"{method.Method} {endpoint.AbsolutePath}" : operationName;

    private static TimeSpan? ReadRetryAfter(HttpResponseMessage response)
    {
        if (response.Headers.RetryAfter?.Delta is { } delta) return delta;
        if (response.Headers.RetryAfter?.Date is { } date) return date - DateTimeOffset.UtcNow;
        return null;
    }

    private Task WaitBeforePollAsync(TimeSpan? configuredDelay, CancellationToken cancellationToken)
    {
        var delay = configuredDelay ?? options.PollingInterval;
        if (delay < TimeSpan.Zero) delay = TimeSpan.Zero;
        if (delay > options.MaximumPollingInterval) delay = options.MaximumPollingInterval;
        return Task.Delay(delay, cancellationToken);
    }

    private sealed record DownstreamResponse(JsonElement? Body, HttpStatusCode StatusCode,
        Uri? Location, TimeSpan? RetryAfter);
}
