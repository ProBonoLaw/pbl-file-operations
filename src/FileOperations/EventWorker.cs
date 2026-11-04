using System.Text.Json;
using Azure;
using Azure.Core;
using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Consumer;
using Azure.Messaging.EventHubs.Processor;
using Azure.Identity;
using Azure.Storage.Blobs;
using System.Diagnostics;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.Azure.Cosmos;

namespace FileOperations;

public sealed class EventWorker : IHostedService, IAsyncDisposable
{
    private readonly EventProcessorClient processor;
    private readonly IHostApplicationLifetime lifetime;
    private readonly ILogger<EventWorker> logger;
    private readonly TelemetryClient telemetry;
    private readonly IngestionFlow? ingestion;
    private readonly WebsiteIngestionFlow? websiteIngestion;
    private readonly HttpFunctions functions;
    private readonly IFailedEventStore failedEvents;
    private readonly SemaphoreSlim processing;
    private readonly string role;
    private readonly int ingestionShardCount = 1;
    private readonly int ingestionShardIndex;
    private int stopping;

    public EventWorker(IHostApplicationLifetime lifetime, IHttpClientFactory clients,
        ILogger<EventWorker> logger, ILoggerFactory loggerFactory, TelemetryClient telemetry,
        IFailedEventStore failedEvents)
        : this(lifetime, clients, logger, loggerFactory, telemetry, failedEvents, null) { }

    public EventWorker(IHostApplicationLifetime lifetime, IHttpClientFactory clients,
        ILogger<EventWorker> logger, ILoggerFactory loggerFactory, TelemetryClient telemetry,
        IFailedEventStore failedEvents, IServiceProvider? services)
    {
        this.lifetime = lifetime;
        this.logger = logger;
        this.telemetry = telemetry;
        this.failedEvents = failedEvents;
        role = Settings.Required("ROLE");
        processing = role == "ingestion" ? new SemaphoreSlim(4, 4) : new SemaphoreSlim(1, 1);
        if (role == "ingestion")
        {
            if (!int.TryParse(Settings.Get("INGESTION_SHARD_COUNT") ?? "1", out var shardCount) ||
                shardCount is < 1 or > 8 ||
                !int.TryParse(Settings.Get("INGESTION_SHARD_INDEX") ?? "0", out var shardIndex) ||
                shardIndex < 0 || shardIndex >= shardCount)
                throw new InvalidOperationException("INGESTION_SHARD_INDEX must be within INGESTION_SHARD_COUNT (1 to 8)");
            ingestionShardCount = shardCount;
            ingestionShardIndex = shardIndex;
            logger.LogInformation("Starting ingestion shard {ShardIndex} of {ShardCount}",
                ingestionShardIndex, ingestionShardCount);
        }
        var checkpointContainer = Settings.StorageBlobs("CHECKPOINT_STORAGE_CONNECTION_STRING")
            .GetBlobContainerClient(Settings.Required("CHECKPOINT_CONTAINER"));
        var connectionOptions = Settings.EventHubConnectionOptions();
        logger.LogInformation("Starting Event Hubs processor with {TransportType} transport",
            connectionOptions.TransportType);
        processor = new EventProcessorClient(
            checkpointContainer,
            Settings.Required("EVENTHUB_CONSUMER_GROUP"),
            Settings.Required("EVENTHUB_NAMESPACE"),
            Settings.Get("EVENTHUB_NAME") ?? "file-operations",
            new DefaultAzureCredential(),
            new EventProcessorClientOptions
            {
                ConnectionOptions = connectionOptions
            });
        var functionClient = clients.CreateClient();
        functionClient.Timeout = TimeSpan.FromMinutes(10);
        var dataIntegrityClient = clients.CreateClient();
        dataIntegrityClient.Timeout = TimeSpan.FromHours(6.1);
        var dataIngestionClient = clients.CreateClient();
        dataIngestionClient.Timeout = TimeSpan.FromHours(6);
        functions = new HttpFunctions(functionClient, loggerFactory.CreateLogger<HttpFunctions>(),
            dataIntegrityClient, dataIngestionClient);
        if (role == "ingestion")
        {
            var graphClient = clients.CreateClient();
            graphClient.Timeout = TimeSpan.FromMinutes(10);
            var notificationHttpClient = clients.CreateClient();
            notificationHttpClient.Timeout = TimeSpan.FromMinutes(10);
            var notificationClient = NotificationService.CreateClient(notificationHttpClient);
            var graphCredential = services?.GetService(typeof(TokenCredential)) as TokenCredential
                ?? new ClientSecretCredential(
                    Settings.Required("SHAREPOINT_TENANT_ID"),
                    Settings.Required("SHAREPOINT_CLIENT_ID"),
                    Settings.Required("SHAREPOINT_CLIENT_SECRET"));
            ingestion = new IngestionFlow(graphClient, functions, notificationClient,
                loggerFactory.CreateLogger<IngestionFlow>(), graphCredential);
            websiteIngestion = new WebsiteIngestionFlow(graphClient, functions,
                loggerFactory.CreateLogger<WebsiteIngestionFlow>());
        }
        processor.PartitionInitializingAsync += args =>
        {
            // Existing checkpoints still win; a new consumer group replays retained events.
            args.DefaultStartingPosition = EventPosition.Earliest;
            return Task.CompletedTask;
        };
        processor.ProcessEventAsync += ProcessAsync;
        processor.ProcessErrorAsync += ErrorAsync;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (role == "ingestion")
            await functions.WaitForDataIntegrityServiceAsync(cancellationToken);
        if (role is "ingestion" or "deletion")
            await functions.WaitForDataIngestionServiceAsync(cancellationToken);
        await processor.StartProcessingAsync(cancellationToken);
    }

    public Task StopAsync(CancellationToken cancellationToken) => processor.StopProcessingAsync(cancellationToken);

    internal async Task ProcessAsync(ProcessEventArgs args)
    {
        if (args.Data is null) return;
        try
        {
            await processing.WaitAsync(args.CancellationToken);
        }
        catch (OperationCanceledException) when (args.CancellationToken.IsCancellationRequested)
        {
            return;
        }
        if (Volatile.Read(ref stopping) != 0)
        {
            processing.Release();
            return;
        }
        using var logScope = BeginEventLogScope(args.Data);
        var stopwatch = Stopwatch.StartNew();
        var eventKind = "unknown";
        var outcome = "Succeeded";
        using var operation = telemetry.StartOperation<RequestTelemetry>($"{role} event processing");
        operation.Telemetry.Properties["role"] = role;
        Exception? processingError = null;
        try
        {
            using var message = JsonDocument.Parse(args.Data.EventBody.ToMemory());
            var root = message.RootElement;
            var content = root.TryGetProperty("contentData", out var envelope) ? envelope : root;
            if (!content.TryGetProperty("eventKind", out var kind))
                throw new InvalidDataException("Event is missing eventKind");
            eventKind = kind.GetString() ?? "unknown";
            var eventOrder = EventOrder.From(args.Data, args.Partition.PartitionId);
            operation.Telemetry.Properties["eventKind"] = eventKind;
            var isFileIngestion = role == "ingestion" && eventKind == "FileIngestion";
            var isWebsiteIngestion = role == "ingestion" && eventKind == "Website_Data_Ingestion";
            var isFileCleanup = role == "ingestion" && eventKind == "FileIngestionCleanup";
            var shouldProcess = isFileIngestion || isWebsiteIngestion || isFileCleanup ||
                                (role == "deletion" && eventKind == "FileDeletion");
            outcome = shouldProcess ? "Succeeded" : "SkippedUnrelated";
            if ((isFileIngestion || isWebsiteIngestion || isFileCleanup) && !IsThisIngestionShard(content))
                outcome = "SkippedShard";
            else if (isFileIngestion && content.TryGetProperty("isFolder", out var folder) && folder.GetBoolean())
                outcome = "SkippedFolder";
            else if (isFileIngestion)
                await ingestion!.ProcessAsync(content, args.Data.OffsetString, eventOrder, args.CancellationToken);
            else if (isWebsiteIngestion)
                await websiteIngestion!.ProcessAsync(content, eventOrder, args.CancellationToken);
            else if (isFileCleanup)
                await ingestion!.CleanupAsync(content, args.CancellationToken);
            else if (role == "deletion" && eventKind == "FileDeletion")
                await ProcessDeletionAsync(content, eventOrder, args.CancellationToken);
        }
        catch (OperationCanceledException) when (args.CancellationToken.IsCancellationRequested)
        {
            operation.Telemetry.Success = false;
            return;
        }
        catch (Exception error)
        {
            operation.Telemetry.Success = false;
            if (role == "ingestion" && ingestionShardIndex != 0 && eventKind == "unknown" &&
                error is JsonException or InvalidDataException)
            {
                outcome = "SkippedShard";
            }
            else
            {
                if (IsInfrastructureFailure(error))
                {
                    TrackProcessed(eventKind, "InfrastructureFailed", stopwatch.Elapsed);
                    StopForInfrastructureFailure(error, "a required data resource");
                    return;
                }
                outcome = "Failed";
                processingError = error;
                logger.LogError(error,
                    "Failed processing {Role} event on partition {Partition} at sequence {Sequence}",
                    role, args.Partition.PartitionId, args.Data.SequenceNumber);
            }
        }
        finally
        {
            processing.Release();
        }

        if (processingError is not null)
        {
            try
            {
                await StoreFailedEventAsync(args, eventKind, processingError);
            }
            catch (OperationCanceledException) when (args.CancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                TrackProcessed(eventKind, "FailureStoreFailed", stopwatch.Elapsed);
                StopForInfrastructureFailure(error, "failed-event storage");
                return;
            }
        }

        try
        {
            await args.UpdateCheckpointAsync(args.CancellationToken);
        }
        catch (OperationCanceledException) when (args.CancellationToken.IsCancellationRequested)
        {
            operation.Telemetry.Success = false;
            return;
        }
        catch (Exception error)
        {
            operation.Telemetry.Success = false;
            TrackProcessed(eventKind, "CheckpointFailed", stopwatch.Elapsed);
            StopForInfrastructureFailure(error, "checkpoint storage");
            return;
        }

        TrackProcessed(eventKind, outcome, stopwatch.Elapsed);
        operation.Telemetry.Success = outcome != "Failed";
        logger.LogInformation("Processed {EventKind} event with outcome {Outcome} in {DurationMs} ms",
            eventKind, outcome, stopwatch.Elapsed.TotalMilliseconds);
    }

    private async Task StoreFailedEventAsync(ProcessEventArgs args, string eventKind,
        Exception error)
    {
        var partitionId = args.Partition.PartitionId;
        var failedEvent = new FailedEvent(role, partitionId, args.Data.SequenceNumber,
            args.Data.OffsetString, eventKind, error.GetType().FullName ?? error.GetType().Name,
            args.Data.EventBody);
        var blobName = await failedEvents.SaveAsync(failedEvent, args.CancellationToken);
        logger.LogWarning("Stored failed {Role} event as {Blob}", role, blobName);
    }

    internal static bool IsInfrastructureFailure(Exception error) => error switch
    {
        MissingSettingException => true,
        AuthenticationFailedException => true,
        RequestFailedException azureError => IsUnavailable(azureError.Status),
        CosmosException cosmosError => IsUnavailable((int)cosmosError.StatusCode),
        HttpRequestException httpError => IsUnavailable((int)(httpError.StatusCode ?? 0)) ||
            httpError.StatusCode is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden,
        _ => false
    };

    private static bool IsUnavailable(int status) =>
        status is 0 or 401 or 403 or 408 or 429 || status >= 500;

    private void StopForInfrastructureFailure(Exception error, string resource)
    {
        if (Interlocked.Exchange(ref stopping, 1) != 0) return;
        logger.LogCritical(error, "Cannot access {Resource}; stopping {Role} worker without checkpointing",
            resource, role);
        Environment.ExitCode = 1;
        lifetime.StopApplication();
    }

    private void TrackProcessed(string eventKind, string outcome, TimeSpan duration)
    {
        telemetry.TrackEvent("FileOperationProcessed", new Dictionary<string, string>
        {
            ["role"] = role,
            ["eventKind"] = eventKind,
            ["outcome"] = outcome,
            ["durationMs"] = duration.TotalMilliseconds.ToString("F1", System.Globalization.CultureInfo.InvariantCulture)
        });
    }

    private async Task ProcessDeletionAsync(JsonElement content, EventOrder eventOrder,
        CancellationToken cancellationToken)
    {
        if (content.TryGetProperty("isFolder", out var folder) && folder.GetBoolean()) return;
        var payload = new
        {
            sourceId = StringOrNumber(content.GetProperty("id")),
            accountId = content.GetProperty("accountId").GetString(),
            eventOrder,
            isCurrentOrder = false,
            documentName = "not important"
        };
        await functions.RemoveDocumentAsync(payload, cancellationToken);
    }

    private static string? StringOrNumber(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString(),
        JsonValueKind.Number => value.GetRawText(),
        _ => null
    };

    private bool IsThisIngestionShard(JsonElement content)
    {
        if (ingestionShardCount == 1) return true;
        if (!content.TryGetProperty("accountId", out var account) ||
            account.ValueKind != JsonValueKind.String ||
            !content.TryGetProperty("identifier", out var identifier) ||
            identifier.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(account.GetString()) ||
            string.IsNullOrWhiteSpace(identifier.GetString()))
            return ingestionShardIndex == 0;

        return EventPartitioning.ShardForSource(account.GetString()!, identifier.GetString()!,
            ingestionShardCount) == ingestionShardIndex;
    }

    private IDisposable? BeginEventLogScope(EventData eventData)
    {
        try
        {
            using var message = JsonDocument.Parse(eventData.EventBody.ToMemory());
            var root = message.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            var content = root.TryGetProperty("contentData", out var envelope) ? envelope : root;
            if (content.ValueKind != JsonValueKind.Object) return null;

            var dimensions = new Dictionary<string, object?>();
            if (content.TryGetProperty("accountId", out var account) &&
                account.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(account.GetString()))
                dimensions["accountId"] = account.GetString();

            var sourceId = content.TryGetProperty("sourceId", out var source)
                ? StringOrNumber(source)
                : null;
            var eventKind = content.TryGetProperty("eventKind", out var kind) &&
                            kind.ValueKind == JsonValueKind.String
                ? kind.GetString()
                : null;
            if (sourceId is null && eventKind == "Website_Data_Ingestion" &&
                content.TryGetProperty("identifier", out var identifier))
                sourceId = StringOrNumber(identifier);
            if (sourceId is null && eventKind == "FileDeletion" &&
                content.TryGetProperty("id", out var id))
                sourceId = StringOrNumber(id);
            if (!string.IsNullOrWhiteSpace(sourceId)) dimensions["sourceId"] = sourceId;

            return dimensions.Count == 0 ? null : logger.BeginScope(dimensions);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    internal Task ErrorAsync(ProcessErrorEventArgs args)
    {
        if (args.CancellationToken.IsCancellationRequested) return Task.CompletedTask;
        if (args.Exception is RequestFailedException)
        {
            StopForInfrastructureFailure(args.Exception, "checkpoint storage");
            return Task.CompletedTask;
        }
        logger.LogError(args.Exception, "Event Hub error in {Role} on partition {Partition}", role, args.PartitionId);
        return Task.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        processing.Dispose();
        if (ingestion is not null) await ingestion.DisposeAsync();
    }
}
