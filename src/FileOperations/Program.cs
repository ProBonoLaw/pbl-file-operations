using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Azure.Core;
using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Producer;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;
using FileOperations;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.Extensibility;
using Microsoft.Extensions.Logging.ApplicationInsights;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using Microsoft.Azure.Cosmos;

var role = Environment.GetEnvironmentVariable("ROLE") ?? "gateway";

/**
 * Entry point for the FileOperations application.
 * The application can run in different roles: "gateway", "ingestion", or "deletion".
 * The role is determined by the "ROLE" environment variable.
 * Depending on the role, the application will start an HTTP server for the gateway,
 * or run background processing for ingestion and deletion roles.
 *
 */
if (role == "gateway")
{
    var builder = WebApplication.CreateBuilder(args);
    Settings.Configure(builder.Configuration);
    ProcessShutdown.Configure(builder.Services, role);
    builder.Logging.AddJsonConsole(options => options.IncludeScopes = true);
    builder.Services.AddApplicationInsightsTelemetry();
    builder.Services.AddSingleton<Microsoft.ApplicationInsights.AspNetCore.ITelemetryProcessorFactory,
        DependencyUrlTelemetryProcessorFactory>();
    builder.Services.AddSingleton<ITelemetryInitializer>(new RoleNameTelemetryInitializer(role));
    builder.Logging.AddFilter<ApplicationInsightsLoggerProvider>("", LogLevel.Information);
    builder.Services.AddSingleton(new EventHubProducerClient(
        Settings.Required("EVENTHUB_NAMESPACE"),
        Settings.Get("EVENTHUB_NAME") ?? "file-operations",
        new DefaultAzureCredential(),
        new EventHubProducerClientOptions
        {
            ConnectionOptions = Settings.EventHubConnectionOptions()
        }));
    builder.Services.AddSingleton<TokenCredential>(await CreateSharePointCredentialAsync());
    builder.Services.AddSingleton<IngestionStopStore>();
    builder.Services.AddHttpClient();
    builder.Services.AddSingleton(provider => new SharePointGraph(
        provider.GetRequiredService<IHttpClientFactory>().CreateClient(),
        provider.GetRequiredService<TokenCredential>()));
    var app = builder.Build();
    using var shutdown = ProcessShutdown.Watch(app, role);
    app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

    app.MapPost("/v1/file-operations/ingestion", async (
        HttpRequest http, IngestionRequest request, EventHubProducerClient producer,
        SharePointGraph graph, TelemetryClient telemetry, ILogger<Program> logger,
        CancellationToken cancellationToken) =>
    {
        if (!GatewayAuthorized(http))
        {
            telemetry.TrackEvent("FileOperationRequestRejected",
                new Dictionary<string, string> { ["operation"] = "ingestion" });
            return Results.Unauthorized();
        }
        if (string.IsNullOrWhiteSpace(request.AccountId) || string.IsNullOrWhiteSpace(request.Identifier))
            return Results.BadRequest("accountId and identifier are required");
        if (request.EvidenceExtractionMode is not (null or "auto" or "fast" or "thorough"))
            return Results.BadRequest("evidenceExtractionMode must be auto, fast, or thorough");
        var sourceId = request.Identifier;
        if (!request.IsFolder)
        {
            try
            {
                var siteId = await graph.SiteIdAsync(request.AccountId, cancellationToken);
                sourceId = (await graph.MetadataAsync(siteId, request.Identifier,
                    cancellationToken)).ListItemId;
            }
            catch (FileNotFoundException)
            {
                return Results.NotFound("SharePoint file was not found");
            }
        }
        await PublishAsync(producer, new
        {
            accountId = request.AccountId, identifier = request.Identifier,
            isFolder = request.IsFolder, highRes = request.HighRes,
            force = request.Force, evidenceExtractionMode = request.EvidenceExtractionMode,
            evidenceBudgetOverride = request.EvidenceBudgetOverride, eventKind = "FileIngestion"
        }, request.AccountId, sourceId);
        TrackEnqueued(telemetry, logger, "FileIngestion", request.AccountId,
            request.IsFolder ? null : sourceId, request.IsFolder);
        return Results.Accepted();
    });

    app.MapPost("/v1/file-operations/website-ingestion", async (
        HttpRequest http, WebsiteIngestionRequest request, EventHubProducerClient producer,
        TelemetryClient telemetry, ILogger<Program> logger) =>
    {
        if (!GatewayAuthorized(http))
        {
            telemetry.TrackEvent("FileOperationRequestRejected",
                new Dictionary<string, string> { ["operation"] = "website-ingestion" });
            return Results.Unauthorized();
        }
        if (string.IsNullOrWhiteSpace(request.AccountId) ||
            string.IsNullOrWhiteSpace(request.Identifier) || string.IsNullOrWhiteSpace(request.Url))
            return Results.BadRequest("accountId, identifier, and url are required");
        if (!WebsiteIngestionFlow.TryCreateSourceUri(request.Url, out _))
            return Results.BadRequest("url must be an absolute HTTP or HTTPS URL without embedded credentials");

        await PublishAsync(producer, new
        {
            accountId = request.AccountId,
            identifier = request.Identifier,
            url = request.Url,
            highRes = request.HighRes,
            force = request.Force,
            eventKind = "Website_Data_Ingestion"
        }, request.AccountId, request.Identifier);
        TrackEnqueued(telemetry, logger, "Website_Data_Ingestion", request.AccountId, request.Identifier);
        return Results.Accepted();
    });

    app.MapPost("/v1/file-operations/ingestion/stop", async (
        HttpRequest http, StopIngestionRequest request, IngestionStopStore stops,
        TelemetryClient telemetry, ILogger<Program> logger, CancellationToken cancellationToken) =>
    {
        if (!GatewayAuthorized(http)) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(request.AccountId) || string.IsNullOrWhiteSpace(request.SourceId) ||
            string.IsNullOrWhiteSpace(request.JobId)) return Results.BadRequest("accountId, sourceId, and jobId are required");
        var result = await stops.RequestAsync(request.AccountId, request.SourceId, request.JobId, cancellationToken);
        if (result is StopRequestResult.Accepted or StopRequestResult.AlreadyRequested)
        {
            using var scope = logger.BeginScope(new Dictionary<string, object?>
            {
                ["accountId"] = request.AccountId, ["sourceId"] = request.SourceId, ["jobId"] = request.JobId
            });
            logger.LogWarning("Operator requested ingestion stop; result={Result}", result);
            telemetry.TrackEvent("FileIngestionStopRequested", new Dictionary<string, string>
            {
                ["accountId"] = request.AccountId, ["sourceId"] = request.SourceId,
                ["jobId"] = request.JobId, ["result"] = result.ToString()
            });
        }
        return result switch
        {
            StopRequestResult.Accepted or StopRequestResult.AlreadyRequested => Results.Accepted(value: new { status = "stop_requested" }),
            StopRequestResult.Invalid => Results.BadRequest("Invalid jobId"),
            StopRequestResult.Completed => Results.Conflict("Ingestion job is already completed"),
            _ => Results.NotFound("No matching ingestion job for accountId, sourceId, and jobId")
        };
    });

    app.MapPost("/v1/file-operations/deletion", async (
        HttpRequest http, DeletionRequest request, EventHubProducerClient producer,
        TelemetryClient telemetry, ILogger<Program> logger) =>
    {
        if (!GatewayAuthorized(http))
        {
            telemetry.TrackEvent("FileOperationRequestRejected",
                new Dictionary<string, string> { ["operation"] = "deletion" });
            return Results.Unauthorized();
        }
        if (string.IsNullOrWhiteSpace(request.AccountId) || string.IsNullOrWhiteSpace(request.Id))
            return Results.BadRequest("accountId and id are required");
        await PublishAsync(producer, new
        {
            accountId = request.AccountId, id = request.Id,
            isFolder = request.IsFolder, eventKind = "FileDeletion"
        }, request.AccountId, request.Id);
        TrackEnqueued(telemetry, logger, "FileDeletion", request.AccountId, request.Id, request.IsFolder);
        return Results.Accepted();
    });

    await app.RunAsync();
}
else if (role == "data-integrity-api")
{
    var builder = WebApplication.CreateBuilder(args);
    Settings.Configure(builder.Configuration);
    ProcessShutdown.Configure(builder.Services, role);
    builder.Logging.AddJsonConsole(options => options.IncludeScopes = true);
    builder.Services.AddApplicationInsightsTelemetry();
    builder.Services.AddSingleton<Microsoft.ApplicationInsights.AspNetCore.ITelemetryProcessorFactory,
        DependencyUrlTelemetryProcessorFactory>();
    builder.Services.AddSingleton<ITelemetryInitializer>(new RoleNameTelemetryInitializer(role));
    builder.Logging.AddFilter<ApplicationInsightsLoggerProvider>("", LogLevel.Information);
    builder.Services.ConfigureHttpJsonOptions(options =>
    {
        options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
        options.SerializerOptions.IncludeFields = true;
        options.SerializerOptions.PropertyNameCaseInsensitive = true;
    });
    builder.Services.AddDataIntegrityTransformation(builder.Configuration);
    builder.Services.AddSingleton<IIngestionStopStore, IngestionStopStore>();
    var app = builder.Build();
    using var shutdown = ProcessShutdown.Watch(app, role);
    app.MapDataIntegrityEndpoints();
    await app.RunAsync();
}
else if (role == "stop")
{
    var builder = Host.CreateApplicationBuilder(args);
    Settings.Configure(builder.Configuration);
    var encoded = Environment.GetEnvironmentVariable("INGESTION_STOP_REQUEST")
        ?? throw new InvalidOperationException("INGESTION_STOP_REQUEST is required");
    var request = JsonSerializer.Deserialize<StopIngestionRequest>(Convert.FromBase64String(encoded),
        new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
        ?? throw new InvalidDataException("Invalid ingestion stop request");
    if (string.IsNullOrWhiteSpace(request.AccountId) || string.IsNullOrWhiteSpace(request.SourceId) ||
        string.IsNullOrWhiteSpace(request.JobId)) throw new InvalidDataException("Stop request identity is incomplete");
    var result = await new IngestionStopStore().RequestAsync(request.AccountId, request.SourceId, request.JobId,
        CancellationToken.None);
    Console.WriteLine($"Ingestion stop result: {result}");
    if (result is not (StopRequestResult.Accepted or StopRequestResult.AlreadyRequested)) Environment.ExitCode = 1;
}
else if (role is "ingestion" or "deletion")
{
    var builder = Host.CreateApplicationBuilder(args);
    Settings.Configure(builder.Configuration);
    ProcessShutdown.Configure(builder.Services, role);
    builder.Logging.AddJsonConsole(options => options.IncludeScopes = true);
    builder.Services.AddApplicationInsightsTelemetryWorkerService();
    builder.Services.AddSingleton<Microsoft.ApplicationInsights.WorkerService.ITelemetryProcessorFactory,
        DependencyUrlTelemetryProcessorFactory>();
    builder.Services.AddSingleton<ITelemetryInitializer>(new RoleNameTelemetryInitializer(role));
    builder.Logging.AddFilter<ApplicationInsightsLoggerProvider>("", LogLevel.Information);
    builder.Logging.AddFilter("System.Net.Http.HttpClient", LogLevel.Warning);
    builder.Logging.AddFilter<ApplicationInsightsLoggerProvider>(
        "System.Net.Http.HttpClient", LogLevel.Warning);
    builder.Services.AddHttpClient();
    builder.Services.AddSingleton<IFailedEventStore, BlobFailedEventStore>();
    if (role == "ingestion")
        builder.Services.AddSingleton<TokenCredential>(await CreateSharePointCredentialAsync());
    builder.Services.AddHostedService<EventWorker>();
    var host = builder.Build();
    using var shutdown = ProcessShutdown.Watch(host, role);
    await host.RunAsync();
}
else if (role == "shared-resource-sync")
{
    var builder = Host.CreateApplicationBuilder(args);
    Settings.Configure(builder.Configuration);
    ProcessShutdown.Configure(builder.Services, role);
    builder.Logging.AddJsonConsole(options => options.IncludeScopes = true);
    builder.Services.AddApplicationInsightsTelemetryWorkerService();
    builder.Services.AddSingleton<Microsoft.ApplicationInsights.WorkerService.ITelemetryProcessorFactory,
        DependencyUrlTelemetryProcessorFactory>();
    builder.Services.AddSingleton<ITelemetryInitializer>(new RoleNameTelemetryInitializer(role));
    builder.Logging.AddFilter<ApplicationInsightsLoggerProvider>("", LogLevel.Information);
    builder.Logging.AddFilter("System.Net.Http.HttpClient", LogLevel.Warning);
    builder.Logging.AddFilter<ApplicationInsightsLoggerProvider>(
        "System.Net.Http.HttpClient", LogLevel.Warning);
    builder.Services.AddSingleton<TokenCredential>(await CreateSharePointCredentialAsync());
    builder.Services.AddHttpClient<SharePointChangeFeed>(client =>
        client.Timeout = TimeSpan.FromMinutes(2));
    builder.Services.AddSingleton(_ => new CosmosClient(
        Settings.Required("COSMOS_ENDPOINT"), Settings.Required("COSMOS_KEY")));
    builder.Services.AddSingleton<SharedResourceSyncStateStore>();
    builder.Services.AddSingleton(_ => new EventHubProducerClient(
        Settings.Required("EVENTHUB_NAMESPACE"),
        Settings.Get("EVENTHUB_NAME") ?? "file-operations",
        new DefaultAzureCredential(),
        new EventHubProducerClientOptions
        {
            ConnectionOptions = Settings.EventHubConnectionOptions()
        }));
    builder.Services.AddHostedService<SharedResourcesSyncWorker>();
    var host = builder.Build();
    using var shutdown = ProcessShutdown.Watch(host, role);
    await host.RunAsync();
}
else
{
    throw new InvalidOperationException($"Unknown ROLE: {role}");
}

static async Task<TokenCredential> CreateSharePointCredentialAsync()
{
    var certificateVaultUri = Settings.Get("SHAREPOINT_CERTIFICATE_KEY_VAULT_URI");
    if (!string.IsNullOrWhiteSpace(certificateVaultUri))
    {
        var secretClient = new SecretClient(new Uri(certificateVaultUri), new DefaultAzureCredential());
        var certificateSecret = (await secretClient.GetSecretAsync(
            Settings.Required("SHAREPOINT_CERTIFICATE_SECRET_NAME"))).Value.Value;
        var certificate = X509CertificateLoader.LoadPkcs12(
            Convert.FromBase64String(certificateSecret), null,
            X509KeyStorageFlags.EphemeralKeySet);
        return new ClientCertificateCredential(
            Settings.Required("SHAREPOINT_TENANT_ID"),
            Settings.Required("SHAREPOINT_CLIENT_ID"), certificate);
    }
    else
    {
        return new ClientSecretCredential(
            Settings.Required("SHAREPOINT_TENANT_ID"),
            Settings.Required("SHAREPOINT_CLIENT_ID"),
            Settings.Required("SHAREPOINT_CLIENT_SECRET"));
    }
}

static bool GatewayAuthorized(HttpRequest request)
{
    var expected = Encoding.UTF8.GetBytes(Settings.Required("GATEWAY_API_KEY"));
    var supplied = Encoding.UTF8.GetBytes(request.Headers["X-API-Key"].ToString());
    return CryptographicOperations.FixedTimeEquals(expected, supplied);
}

static async Task PublishAsync(EventHubProducerClient producer, object content,
    string accountId, string sourceId)
{
    var bytes = JsonSerializer.SerializeToUtf8Bytes(new { contentData = content },
        new JsonSerializerOptions { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull });
    var options = new SendEventOptions
    {
        PartitionKey = EventPartitioning.ForSource(accountId, sourceId)
    };
    await producer.SendAsync([new EventData(bytes)], options);
}

static void TrackEnqueued(TelemetryClient telemetry, ILogger logger, string eventKind,
    string accountId, string? sourceId, bool? isFolder = null)
{
    var logDimensions = new Dictionary<string, object?> { ["accountId"] = accountId };
    if (!string.IsNullOrWhiteSpace(sourceId)) logDimensions["sourceId"] = sourceId;
    using var logScope = logger.BeginScope(logDimensions);
    var properties = new Dictionary<string, string>
    {
        ["eventKind"] = eventKind
    };
    if (isFolder.HasValue) properties["isFolder"] = isFolder.Value.ToString();
    telemetry.TrackEvent("FileOperationEnqueued", properties);
    if (isFolder.HasValue)
        logger.LogInformation("Enqueued {EventKind} event; isFolder={IsFolder}", eventKind, isFolder.Value);
    else
        logger.LogInformation("Enqueued {EventKind} event", eventKind);
}

public record IngestionRequest(string AccountId, string Identifier, bool IsFolder, bool? HighRes, bool? Force,
    string? EvidenceExtractionMode = null, bool? EvidenceBudgetOverride = null);
public record WebsiteIngestionRequest(string AccountId, string Identifier, string Url, bool? HighRes, bool? Force);
public record DeletionRequest(string AccountId, string Id, bool IsFolder);
public record StopIngestionRequest(string AccountId, string SourceId, string JobId);
