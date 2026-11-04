using DaatPhoenix.HttpOrchestration;
using System.Text.Json;

namespace FileOperations;

public sealed class HttpFunctions
{
    private readonly HttpClient dataIntegrityClient;
    private readonly HttpClient dataIngestionClient;
    private readonly ILogger<HttpFunctions>? logger;
    private readonly HttpOrchestrationClient orchestration;
    private readonly HttpOrchestrationClient dataIntegrityOrchestration;
    private readonly HttpOrchestrationClient dataIngestionOperations;

    public HttpFunctions(HttpClient client, ILogger<HttpFunctions>? logger = null,
        HttpClient? dataIntegrityClient = null, HttpClient? dataIngestionClient = null)
    {
        this.dataIntegrityClient = dataIntegrityClient ?? client;
        this.logger = logger;
        orchestration = new HttpOrchestrationClient(client, logger);
        dataIntegrityOrchestration = ReferenceEquals(client, this.dataIntegrityClient)
            ? orchestration
            : new HttpOrchestrationClient(this.dataIntegrityClient, logger);
        var ingestionClient = dataIngestionClient ?? client;
        this.dataIngestionClient = ingestionClient;
        dataIngestionOperations = ReferenceEquals(client, ingestionClient)
            ? orchestration
            : new HttpOrchestrationClient(ingestionClient, logger);
    }

    public Task<JsonElement?> SendAsync(string method, string setting, object payload,
        CancellationToken cancellationToken, bool allowNotFound = false, int retryCount = 1,
        TimeSpan? retryDelay = null) =>
        SendAsync(method, setting, payload, cancellationToken, allowNotFound, retryCount, retryDelay,
            includeFunctionKey: true);

    internal Task<JsonElement?> SendAsync(string method, string setting, object payload,
        CancellationToken cancellationToken, bool allowNotFound, int retryCount,
        TimeSpan? retryDelay, bool includeFunctionKey)
    {
        var (endpoint, headers) = GetRequestConfiguration(setting, includeFunctionKey);
        return orchestration.SendAsync(new HttpMethod(method), endpoint, payload, setting, headers,
            cancellationToken, allowNotFound, retryCount, retryDelay);
    }

    public Task<JsonElement?> IngestDocumentAsync(object payload, CancellationToken cancellationToken) =>
        dataIngestionOperations.SendAsync(HttpMethod.Post,
            DataIngestionServiceEndpoint("internal/data-ingestion/ingest"), payload,
            "in-cluster data ingestion", null, cancellationToken);

    public Task<JsonElement?> RemoveDocumentAsync(object payload, CancellationToken cancellationToken) =>
        dataIngestionOperations.SendAsync(HttpMethod.Delete,
            DataIngestionServiceEndpoint("internal/data-ingestion/remove"), payload,
            "in-cluster data removal", null, cancellationToken);

    public Task<JsonElement?> FindMarkdownAsync(object payload, CancellationToken cancellationToken)
    {
        var endpoint = DataIntegrityEndpoint("lookup");
        return dataIntegrityOrchestration.SendAsync(HttpMethod.Post, endpoint, payload, "data integrity cache lookup",
            null, cancellationToken, allowNotFound: true, retryCount: 3);
    }

    public Task<JsonElement?> TransformMarkdownAsync(object payload, CancellationToken cancellationToken)
    {
        var endpoint = DataIntegrityEndpoint("transform");
        return dataIntegrityOrchestration.SendAsync(HttpMethod.Post, endpoint, payload, "data integrity transformation",
            null, cancellationToken, retryCount: 3);
    }

    public async Task WaitForDataIntegrityServiceAsync(CancellationToken cancellationToken)
    {
        var endpoint = DataIntegrityServiceEndpoint("healthz");
        logger?.LogInformation("Waiting for the in-cluster Data Integrity API to become ready");
        while (true)
        {
            try
            {
                using var response = await dataIntegrityClient.GetAsync(endpoint, cancellationToken);
                if (response.IsSuccessStatusCode)
                {
                    logger?.LogInformation("The in-cluster Data Integrity API is ready");
                    return;
                }
                logger?.LogInformation("Data Integrity API health check returned HTTP {StatusCode}",
                    (int)response.StatusCode);
            }
            catch (HttpRequestException exception)
            {
                logger?.LogInformation("Data Integrity API is not reachable yet: {Error}", exception.Message);
            }
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
        }
    }

    public async Task WaitForDataIngestionServiceAsync(CancellationToken cancellationToken)
    {
        var endpoint = DataIngestionServiceEndpoint("healthz");
        logger?.LogInformation("Waiting for the in-cluster Data Ingestion API to become ready");
        while (true)
        {
            try
            {
                using var response = await dataIngestionClient.GetAsync(endpoint, cancellationToken);
                if (response.IsSuccessStatusCode)
                {
                    logger?.LogInformation("The in-cluster Data Ingestion API is ready");
                    return;
                }
                logger?.LogInformation("Data Ingestion API health check returned HTTP {StatusCode}",
                    (int)response.StatusCode);
            }
            catch (HttpRequestException exception)
            {
                logger?.LogInformation("Data Ingestion API is not reachable yet: {Error}", exception.Message);
            }
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
        }
    }

    private static Uri DataIntegrityEndpoint(string operation)
    {
        return DataIntegrityServiceEndpoint($"internal/data-integrity/{operation}");
    }

    private static Uri DataIntegrityServiceEndpoint(string path)
    {
        var configuredUrl = Settings.Required("DATA_INTEGRITY_SERVICE_URL");
        if (!Uri.TryCreate(configuredUrl, UriKind.Absolute, out var serviceUri) ||
            (serviceUri.Scheme != Uri.UriSchemeHttp && serviceUri.Scheme != Uri.UriSchemeHttps))
            throw new InvalidDataException("DATA_INTEGRITY_SERVICE_URL must be an absolute HTTP or HTTPS URL");
        return new Uri(serviceUri, $"/{path.TrimStart('/')}");
    }

    private static Uri DataIngestionServiceEndpoint(string path)
    {
        var configuredUrl = Settings.Required("DATA_INGESTION_SERVICE_URL");
        if (!Uri.TryCreate(configuredUrl, UriKind.Absolute, out var serviceUri) ||
            (serviceUri.Scheme != Uri.UriSchemeHttp && serviceUri.Scheme != Uri.UriSchemeHttps))
            throw new InvalidDataException("DATA_INGESTION_SERVICE_URL must be an absolute HTTP or HTTPS URL");
        return new Uri(serviceUri, $"/{path.TrimStart('/')}");
    }

    private static (Uri Endpoint, IReadOnlyDictionary<string, string>? Headers) GetRequestConfiguration(
        string setting, bool includeFunctionKey)
    {
        var configuredUrl = Settings.Required(setting);
        if (!Uri.TryCreate(configuredUrl, UriKind.Absolute, out var endpoint))
            throw new InvalidDataException($"Downstream setting {setting} must be an absolute URL");

        var key = includeFunctionKey ? Settings.Get(setting.Replace("_URL", "_API_KEY")) : null;
        IReadOnlyDictionary<string, string>? headers = string.IsNullOrEmpty(key)
            ? null
            : new Dictionary<string, string> { ["x-functions-key"] = key };
        return (endpoint, headers);
    }
}
