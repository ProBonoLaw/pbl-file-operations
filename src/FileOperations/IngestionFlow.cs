using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using Azure.Core;
using Azure.Identity;
using Azure;
using Azure.Data.Tables;
using Azure.Storage.Blobs;
using Microsoft.Azure.Cosmos;
using Newtonsoft.Json.Linq;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;

namespace FileOperations;

public sealed class IngestionFlow : IAsyncDisposable
{
    private readonly TableClient table;
    private readonly BlobServiceClient blobs;
    private readonly CosmosClient cosmos;
    private readonly SharePointGraph graph;
    private readonly HttpFunctions functions;
    private readonly NotificationService notifications;
    private readonly ILogger<IngestionFlow>? logger;
    private readonly IngestionEventPublisher publisher;
    private readonly IngestionStopStore stops;

    public IngestionFlow(HttpClient client, HttpFunctions functions, NotificationClient notificationClient,
        ILogger<IngestionFlow>? logger = null)
        : this(client, functions, notificationClient, logger, new ClientSecretCredential(
            Settings.Required("SHAREPOINT_TENANT_ID"),
            Settings.Required("SHAREPOINT_CLIENT_ID"),
            Settings.Required("SHAREPOINT_CLIENT_SECRET"))) { }

    public IngestionFlow(HttpClient client, HttpFunctions functions, NotificationClient notificationClient,
        ILogger<IngestionFlow>? logger, TokenCredential graphCredential)
        : this(client, functions, notificationClient, logger, graphCredential,
            Settings.StorageTables().GetTableClient(Settings.Get("TABLE_NAME") ?? "IngestionProgress"),
            Settings.StorageBlobs(), new CosmosClient(Settings.Required("COSMOS_ENDPOINT"), Settings.Required("COSMOS_KEY")),
            new IngestionEventPublisher(), new IngestionStopStore()) { }

    internal IngestionFlow(HttpClient client, HttpFunctions functions, NotificationClient notificationClient,
        ILogger<IngestionFlow>? logger, TokenCredential graphCredential, TableClient table,
        BlobServiceClient blobs, CosmosClient cosmos, IngestionEventPublisher publisher, IngestionStopStore stops,
        INotificationRecipientStore? notificationRecipients = null)
    {
        this.table = table;
        this.blobs = blobs;
        this.cosmos = cosmos;
        this.publisher = publisher;
        this.stops = stops;
        graph = new SharePointGraph(client, graphCredential);
        this.functions = functions;
        this.logger = logger;
        notifications = new NotificationService(notificationRecipients ?? new CosmosNotificationRecipientStore(cosmos),
            notificationClient, logger);
    }

    public async Task ProcessAsync(JsonElement content, string offset,
        EventOrder eventOrder, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(eventOrder);
        if (content.TryGetProperty("isFolder", out var folder) && folder.GetBoolean())
        {
            logger?.LogInformation("Skipping ingestion for a folder");
            return;
        }
        var accountId = content.GetProperty("accountId").GetString()!;
        var identifier = content.GetProperty("identifier").GetString()!;
        _ = EvidenceExtractionOptions.FromContent(content);
        _ = EvidenceExtractionOptions.BudgetOverrideFromContent(content);
        if (string.IsNullOrWhiteSpace(accountId) || string.IsNullOrWhiteSpace(identifier))
            throw new InvalidDataException("Ingestion requires accountId and identifier");
        var partition = ProgressPartitionKey(accountId, identifier);
        var row = IngestionProgress.RowKey(offset, eventOrder);
        var jobId = partition + ":" + row;
        var found = await table.GetEntityIfExistsAsync<TableEntity>(partition, row,
            cancellationToken: cancellationToken);
        var existing = found.HasValue ? found.Value : null;
        if (existing is { } previous &&
            previous.GetString("RuntimeStatus") is "Completed" or "AwaitingEvidence" or "Stopped")
        {
            logger?.LogInformation("Skipping ingestion job {jobId} already marked {RuntimeStatus}",
                jobId, previous.GetString("RuntimeStatus"));
            return;
        }
        await SetProgressAsync(partition, row, "Running", cancellationToken);
        await table.UpsertEntityAsync(new TableEntity(partition, row)
        {
            ["AccountId"] = accountId, ["Identifier"] = identifier
        }, TableUpdateMode.Merge, cancellationToken);
        try
        {
            if (existing is { } savedProgress && savedProgress.GetString("Work") is { } savedWork)
            {
                using var saved = JsonDocument.Parse(savedWork);
                var sourceId = saved.RootElement.GetProperty("sourceId").GetString()!;
                await stops.AssertOpenAsync(accountId, sourceId, jobId, cancellationToken);
                await SubmitWorkAsync(saved.RootElement, cancellationToken);
            }
            else
                await IngestAsync(content, accountId, identifier, eventOrder, partition, row, cancellationToken);
        }
        catch (FileNotFoundException)
        {
            await SetProgressAsync(partition, row, "Completed", cancellationToken);
        }
        catch
        {
            var progress = !cancellationToken.IsCancellationRequested
                ? (await table.GetEntityAsync<TableEntity>(partition, row, cancellationToken: cancellationToken)).Value
                : null;
            var sourceId = progress?.GetString("SourceId");
            if (sourceId is null && progress?.GetString("Work") is { } savedWork)
            {
                using var saved = JsonDocument.Parse(savedWork);
                sourceId = saved.RootElement.GetProperty("sourceId").GetString();
            }
            if (sourceId is not null &&
                await stops.IsStoppedAsync(accountId, sourceId, jobId, cancellationToken))
            {
                await SetProgressAsync(partition, row, "Stopped", cancellationToken);
                logger?.LogWarning("Stopped ingestion job {JobId} at operator request", jobId);
                return;
            }
            await SetProgressAsync(partition, row, "Failed", cancellationToken);
            var filepath = await ResolveNotificationPathAsync(accountId, identifier, cancellationToken);
            await notifications.SendIngestionAsync(accountId, IngestionStatus.FAILED, identifier, filepath,
                cancellationToken);
            throw;
        }
    }

    private async Task IngestAsync(JsonElement content, string accountId, string identifier,
        EventOrder eventOrder, string partition, string row, CancellationToken cancellationToken)
    {
        logger?.LogInformation("Resolving SharePoint site and file metadata");
        var siteId = await graph.SiteIdAsync(accountId, cancellationToken);
        var item = await graph.MetadataAsync(siteId, identifier, cancellationToken);
        using var sourceScope = logger?.BeginScope(new Dictionary<string, object?>
        {
            ["accountId"] = accountId,
            ["sourceId"] = item.ListItemId
        });
        logger?.LogInformation("Resolved SharePoint item for accountId {accountId}, sourceId {sourceId}",
            accountId, item.ListItemId);
        await table.UpsertEntityAsync(new TableEntity(partition, row)
        {
            ["SourceId"] = item.ListItemId
        }, TableUpdateMode.Merge, cancellationToken);
        await stops.AssertOpenAsync(accountId, item.ListItemId, partition + ":" + row, cancellationToken);
        if (item.Path.Contains("_GeneratedDocuments", StringComparison.Ordinal))
        {
            logger?.LogInformation("Skipping generated document ingestion");
            await SetProgressAsync(partition, row, "Completed", cancellationToken);
            return;
        }
        var sourceUrl = await graph.SharingLinkAsync(siteId, item.DriveId, cancellationToken);
        var rawName = Guid.NewGuid().ToString();
        var directMarkdown = item.MediaType == "text/html";
        var inputContainer = directMarkdown ? "results" : "input";
        var inputBlob = blobs.GetBlobContainerClient(inputContainer).GetBlobClient(rawName);

        logger?.LogInformation("Downloading SharePoint file and storing it in the {Container} container",
            inputContainer);
        using (var response = await graph.ContentAsync(siteId, item.DriveId, cancellationToken))
        await using (var stream = await response.Content.ReadAsStreamAsync(cancellationToken))
        {
            if (directMarkdown)
            {
                logger?.LogInformation("Converting HTML content to Markdown");
                using var reader = new StreamReader(stream, Encoding.UTF8);
                var html = await reader.ReadToEndAsync(cancellationToken);
                var converted = await functions.SendAsync("POST", "HTML_TO_MD_URL",
                    new { html }, cancellationToken);
                if (converted?.ValueKind != JsonValueKind.String)
                    throw new InvalidDataException("HTML converter must return Markdown text");
                await inputBlob.UploadAsync(BinaryData.FromString(converted.Value.GetString()!),
                    overwrite: false, cancellationToken);
            }
            else
            {
                await inputBlob.UploadAsync(stream, overwrite: false, cancellationToken);
            }
        }

        var resultContainer = inputContainer;
        var resultPath = rawName;
        string? extractionPath = null;
        string? analysisId = null;
        string? renderedPath = null;
        if (!directMarkdown)
        {
            logger?.LogInformation("Resolving cached Markdown or starting document conversion");
            var conversionInput = new Dictionary<string, object?>
            {
                ["containerName"] = "input", ["containerPath"] = rawName,
                ["sourceId"] = item.ListItemId, ["filename"] = item.Name,
                ["filePath"] = item.Path, ["modifiedDate"] = item.ModifiedDate,
                ["accountId"] = accountId,
                ["jobId"] = partition + ":" + row,
                ["highRes"] = OptionalBoolean(content, "highRes"),
                ["force"] = OptionalBoolean(content, "force")
            };
            var mediaType = ExtractionPolicy.MediaType(item.Name, item.Path);
            var media = mediaType is not null;
            var officeRenderer = new OfficePdfRenderer(Settings.Get("OFFICE_PDF_RENDERER") ?? "soffice");
            if (!media && await officeRenderer.RequiresPdfAsync(inputBlob, item.Name, cancellationToken))
            {
                renderedPath = rawName + ".pdf";
                var rendered = blobs.GetBlobContainerClient("input").GetBlobClient(renderedPath);
                var rendition = await officeRenderer.RenderAsync(inputBlob, rendered, item.Name, cancellationToken, blobs.GetBlobContainerClient("results"));
                conversionInput["containerPath"] = renderedPath;
                conversionInput["rendition"] = rendition;
            }
            var feedbackExists = false;
            JsonElement? transformed;
            if (mediaType is not null)
            {
                var feedback = await GetFeedbackAsync(accountId, item.ListItemId, cancellationToken);
                var cuSelected = Settings.Get($"INTEGRITY_{mediaType.ToUpperInvariant()}_PROVIDER") == ExtractionPolicy.CuProvider
                    && ExtractionPolicy.MediaExtension(item.Name, item.Path) is not (".webm" or ".aiff" or ".amr");
                (transformed, feedbackExists) = await MediaFeedbackExtraction.ResolveAsync(
                    functions, conversionInput, cuSelected, feedback, cancellationToken);
            }
            else
            {
                var cached = await functions.FindMarkdownAsync(conversionInput, cancellationToken);
                transformed = cached ?? await functions.TransformMarkdownAsync(conversionInput, cancellationToken);
            }
            (resultContainer, resultPath) = Location(transformed);
            await stops.AssertOpenAsync(accountId, item.ListItemId, partition + ":" + row, cancellationToken);
            (extractionPath, analysisId) = ExtractionLocation(transformed);
            if (media && !feedbackExists && !conversionInput.ContainsKey("speakerNames"))
                await CreateFeedbackAsync(accountId, identifier, item, conversionInput,
                    resultContainer, resultPath, siteId, cancellationToken, analysisId);
        }

        if (!directMarkdown)
        {
            // Cache results can be shared by another ingestion job. Keep an immutable,
            // job-owned copy so this job's cleanup cannot remove another job's input.
            var convertedBlob = blobs.GetBlobContainerClient(resultContainer).GetBlobClient(resultPath);
            var snapshotPath = "ingestion/" + rawName + ".md";
            var snapshot = blobs.GetBlobContainerClient("results").GetBlobClient(snapshotPath);
            var convertedDownload = await convertedBlob.DownloadStreamingAsync(cancellationToken: cancellationToken);
            await using var convertedStream = convertedDownload.Value.Content;
            await snapshot.UploadAsync(convertedStream, overwrite: false, cancellationToken);
            resultContainer = "results";
            resultPath = snapshotPath;
            if (extractionPath is not null)
            {
                var extractionSnapshotPath = snapshotPath + ".extraction.json";
                var packageDownload = await blobs.GetBlobContainerClient(convertedBlob.BlobContainerName)
                    .GetBlobClient(extractionPath).DownloadStreamingAsync(cancellationToken: cancellationToken);
                await using var packageStream = packageDownload.Value.Content;
                await blobs.GetBlobContainerClient("results").GetBlobClient(extractionSnapshotPath)
                    .UploadAsync(packageStream, overwrite: false, cancellationToken);
                extractionPath = extractionSnapshotPath;
            }
        }

        var cleanupBlobs = new List<object> { new { containerName = inputContainer, containerPath = rawName } };
        if (resultContainer != inputContainer || resultPath != rawName)
            cleanupBlobs.Add(new { containerName = resultContainer, containerPath = resultPath });
        if (extractionPath is not null)
            cleanupBlobs.Add(new { containerName = resultContainer, containerPath = extractionPath });
        if (renderedPath is not null)
            cleanupBlobs.Add(new { containerName = "input", containerPath = renderedPath });
        var work = JsonSerializer.SerializeToElement(new
        {
            containerName = resultContainer, containerPath = resultPath,
            sourceUrl, documentName = item.Name, sourceId = item.ListItemId,
            accountId, identifier, filepath = item.Path, isCurrentOrder = false, eventOrder,
            extractionContainerPath = extractionPath,
            evidenceExtractionMode = EvidenceExtractionOptions.FromContent(content),
            evidenceBudgetOverride = EvidenceExtractionOptions.BudgetOverrideFromContent(content),
            deferEvidenceExtraction = true,
            jobId = partition + ":" + row, progressPartition = partition, progressRow = row, cleanupBlobs
        });
        // Save the exact API input before submitting it, so broker retries reuse the same blobs and job.
        await stops.AssertOpenAsync(accountId, item.ListItemId, partition + ":" + row, cancellationToken);
        await table.UpsertEntityAsync(new TableEntity(partition, row)
        {
            ["RuntimeStatus"] = "Running", ["Work"] = work.GetRawText()
        }, TableUpdateMode.Merge, cancellationToken);
        await SubmitWorkAsync(work, cancellationToken);
    }

    private async Task SubmitWorkAsync(JsonElement work, CancellationToken cancellationToken)
    {
        var accountId = work.GetProperty("accountId").GetString()!;
        var sourceId = work.GetProperty("sourceId").GetString()!;
        var jobId = work.GetProperty("jobId").GetString()!;
        logger?.LogInformation("Submitting search chunks to the Data Ingestion API");
        await IngestionCompletion.SubmitAsync(
            async () => {
                await stops.AssertOpenAsync(accountId, sourceId, jobId, cancellationToken);
                await functions.IngestDocumentAsync(work, cancellationToken);
                await stops.AssertOpenAsync(accountId, sourceId, jobId, cancellationToken);
            },
            async () => {
                await stops.AssertOpenAsync(accountId, sourceId, jobId, cancellationToken);
                await SendStageNotificationAsync(work, IngestionStatus.PRELIMINARY, cancellationToken);
            },
            async () => {
                await stops.AssertOpenAsync(accountId, sourceId, jobId, cancellationToken);
                await publisher.PublishAsync(work, "EvidenceExtraction", cancellationToken);
            });
        var partition = work.GetProperty("progressPartition").GetString()!;
        var row = work.GetProperty("progressRow").GetString()!;
        var progress = await table.GetEntityAsync<TableEntity>(partition, row, cancellationToken: cancellationToken);
        if (progress.Value.GetString("RuntimeStatus") == "Running")
        {
            progress.Value["RuntimeStatus"] = "AwaitingEvidence";
            try { await table.UpdateEntityAsync(progress.Value, progress.Value.ETag, TableUpdateMode.Merge, cancellationToken); }
            catch (RequestFailedException error) when (error.Status == 412) { /* Cleanup already advanced this job. */ }
        }
        logger?.LogInformation("Queued evidence extraction; retaining ingestion input until cleanup");
    }

    public async Task CleanupAsync(JsonElement content, CancellationToken cancellationToken)
    {
        var accountId = content.GetProperty("accountId").GetString()!;
        var identifier = content.GetProperty("identifier").GetString()!;
        var partition = content.GetProperty("progressPartition").GetString()!;
        var row = content.GetProperty("progressRow").GetString()!;
        var jobId = content.GetProperty("jobId").GetString()!;
        if (partition != ProgressPartitionKey(accountId, identifier) || jobId != partition + ":" + row)
            throw new InvalidDataException("Cleanup job does not match ingestion progress");
        var progress = await table.GetEntityAsync<TableEntity>(partition, row, cancellationToken: cancellationToken);
        if (progress.Value.GetString("RuntimeStatus") == "Completed") return;
        using var saved = JsonDocument.Parse(progress.Value.GetString("Work")
            ?? throw new InvalidDataException("Cleanup requires persisted ingestion input"));
        var work = saved.RootElement;
        if (!System.Text.Json.Nodes.JsonNode.DeepEquals(
            System.Text.Json.Nodes.JsonNode.Parse(content.GetProperty("cleanupBlobs").GetRawText()),
            System.Text.Json.Nodes.JsonNode.Parse(work.GetProperty("cleanupBlobs").GetRawText())))
            throw new InvalidDataException("Cleanup locations do not match the saved ingestion input");
        var status = content.TryGetProperty("status", out var statusValue) ? statusValue.GetString() : "SUCCESS";
        if (progress.Value.GetBoolean("StopRequested") == true) status = "FAILED";
        await IngestionCompletion.CleanupAsync(status!,
            notificationStatus => SendStageNotificationAsync(work, notificationStatus, cancellationToken),
            async () =>
            {
                foreach (var location in work.GetProperty("cleanupBlobs").EnumerateArray())
                    await blobs.GetBlobContainerClient(location.GetProperty("containerName").GetString()!)
                        .GetBlobClient(location.GetProperty("containerPath").GetString()!)
                        .DeleteIfExistsAsync(Azure.Storage.Blobs.Models.DeleteSnapshotsOption.IncludeSnapshots, cancellationToken: cancellationToken);
            }, evidenceExtractionSkipped: OptionalBoolean(content, "evidenceExtractionSkipped") == true);
        await SetProgressAsync(partition, row,
            progress.Value.GetBoolean("StopRequested") == true ? "Stopped" : status == "FAILED" ? "Failed" : "Completed",
            cancellationToken);
        if (status == "FAILED")
            logger?.LogInformation("Handled FileIngestionCleanup for a failed ingestion; retained input and evidence artifacts for recovery");
        else
            logger?.LogInformation("Finished FileIngestionCleanup with status {Status}", status);
    }

    private async Task SendStageNotificationAsync(JsonElement work, IngestionStatus status,
        CancellationToken cancellationToken)
    {
        var partition = work.GetProperty("progressPartition").GetString()!;
        var row = work.GetProperty("progressRow").GetString()!;
        // Persist intermediate acknowledgements so cleanup/publication retries
        // do not resend a completed stage. Sending and saving are not atomic.
        var marker = status switch
        {
            IngestionStatus.PRELIMINARY => "PreliminaryNotified",
            IngestionStatus.EVIDENCE_EXTRACTION => "EvidenceExtractionNotified",
            _ => null
        };
        if (marker is not null)
        {
            var progress = await table.GetEntityAsync<TableEntity>(partition, row,
                cancellationToken: cancellationToken);
            if (progress.Value.GetBoolean(marker) == true) return;
        }
        await notifications.SendIngestionAsync(work.GetProperty("accountId").GetString()!, status,
            work.GetProperty("identifier").GetString()!, work.GetProperty("filepath").GetString(), cancellationToken);
        if (marker is not null)
            await table.UpsertEntityAsync(new TableEntity(partition, row) { [marker] = true },
                TableUpdateMode.Merge, cancellationToken);
    }

    private async Task<string?> ResolveNotificationPathAsync(string accountId, string identifier,
        CancellationToken cancellationToken)
    {
        try
        {
            var siteId = await graph.SiteIdAsync(accountId, cancellationToken);
            var item = await graph.MetadataAsync(siteId, identifier, cancellationToken);
            return item.Path;
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            logger?.LogWarning(error,
                "Could not resolve the SharePoint path for a failure notification; using the identifier");
            return null;
        }
    }

    private async Task<MediaFeedback> GetFeedbackAsync(
        string accountId, string itemId, CancellationToken cancellationToken)
    {
        var container = CosmosContainer("clientFeedbackRequests");
        var query = new QueryDefinition(
            "SELECT TOP 1 c.id, c.response, c.analysisId FROM c WHERE c.accountId = @account AND c.sourceId = @source ORDER BY c.createdAt DESC")
            .WithParameter("@account", accountId).WithParameter("@source", itemId);
        using var iterator = container.GetItemQueryIterator<JObject>(query,
            requestOptions: new QueryRequestOptions { PartitionKey = new PartitionKey(accountId) });
        while (iterator.HasMoreResults)
        {
            var page = await iterator.ReadNextAsync(cancellationToken);
            var found = page.FirstOrDefault();
            if (found is null) continue;
            var response = found["response"];
            return new(true,
                TokenValue(response?["speakerNames"] ?? response?["SpeakerNames"]),
                TokenValue(response?["metadata"] ?? response?["Metadata"]), found["analysisId"]?.Value<string>());
        }
        return new(false, null, null, null);
    }

    private async Task CreateFeedbackAsync(string accountId, string identifier, GraphItem item,
        Dictionary<string, object?> conversionInput, string resultContainer, string resultPath,
        string siteId, CancellationToken cancellationToken, string? analysisId = null)
    {
        var folder = Guid.NewGuid().ToString();
        var filename = Guid.NewGuid() + ".md";
        var blob = blobs.GetBlobContainerClient(resultContainer).GetBlobClient(resultPath);
        var properties = await blob.GetPropertiesAsync(cancellationToken: cancellationToken);
        var download = await blob.DownloadStreamingAsync(cancellationToken: cancellationToken);
        await using var markdown = download.Value.Content;
        var uploaded = await graph.UploadFeedbackAsync(siteId, folder, filename, markdown,
            properties.Value.ContentLength, cancellationToken);
        var path = $"/Shared Documents/_GeneratedDocuments/{folder}/{filename}";
        var feedbackId = Guid.NewGuid().ToString();
        var feedback = JObject.Parse(JsonSerializer.Serialize(new
        {
            id = feedbackId, accountId, sourceId = item.ListItemId, identifier,
            type = "speakerNames", status = "pending", input = conversionInput,
            analysisId,
            markdownPath = path, createdAt = DateTimeOffset.UtcNow.ToString("O"),
            markdownSourceId = uploaded.ListId, markdownUniqueId = uploaded.DriveId
        }));
        await CosmosContainer("clientFeedbackRequests")
            .CreateItemAsync(feedback, new PartitionKey(accountId), cancellationToken: cancellationToken);
        await notifications.SendFeedbackRequiredAsync(accountId, feedbackId, item.ListItemId, path,
            cancellationToken);
    }

    private Container CosmosContainer(string name) => cosmos.GetContainer(
        Settings.Get("COSMOS_DATABASE") ?? "db_conversation_history", name);

    private static object? TokenValue(JToken? token) => token is null || token.Type == JTokenType.Null
        ? null : JsonSerializer.Deserialize<JsonElement>(token.ToString(Newtonsoft.Json.Formatting.None));

    private static bool? OptionalBoolean(JsonElement content, string name) =>
        content.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? value.GetBoolean() : null;

    private async Task SetProgressAsync(string partition, string row, string status,
        CancellationToken cancellationToken)
    {
        var entity = new TableEntity(partition, row) { ["RuntimeStatus"] = status };
        await table.UpsertEntityAsync(entity, TableUpdateMode.Merge, cancellationToken);
    }

    public static (string Container, string Path) Location(JsonElement? result)
    {
        if (result is null) throw new InvalidDataException("Converter returned no location");
        var body = result.Value;
        if (body.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Converter returned an invalid location");
        if (TryGetPropertyIgnoreCase(body, "output", out var output)) body = output;
        if (body.ValueKind == JsonValueKind.String)
        {
            var failure = body.GetString();
            if (!string.IsNullOrWhiteSpace(failure))
            {
                var detail = failure.Length > 512 ? failure[..512] : failure;
                throw new InvalidDataException($"Converter returned failure output: {detail}");
            }
            throw new InvalidDataException("Converter returned an empty failure output");
        }
        if (body.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Converter returned an invalid output");
        var container = TryGetPropertyIgnoreCase(body, "ContainerName", out var containerValue)
            ? containerValue.GetString() : null;
        var path = TryGetPropertyIgnoreCase(body, "ContainerPath", out var pathValue)
            ? pathValue.GetString() : null;
        if (container is null && TryGetPropertyIgnoreCase(body, "output/ContainerName", out var flatContainer))
            container = flatContainer.GetString();
        if (path is null && TryGetPropertyIgnoreCase(body, "output/ContainerPath", out var flatPath))
            path = flatPath.GetString();
        if (string.IsNullOrWhiteSpace(container) || string.IsNullOrWhiteSpace(path))
        {
            var properties = string.Join(", ", body.EnumerateObject().Select(property => property.Name));
            throw new InvalidDataException(
                $"Converter did not return ContainerName and ContainerPath; output properties: {properties}");
        }
        return (container, path);
    }

    public static (string? Path, string? AnalysisId) ExtractionLocation(JsonElement? result)
    {
        if (result is null) return (null, null);
        var body = result.Value;
        if (TryGetPropertyIgnoreCase(body, "output", out var output)) body = output;
        string? path = TryGetPropertyIgnoreCase(body, "extractionContainerPath", out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() : null;
        string? analysisId = TryGetPropertyIgnoreCase(body, "analysisId", out var id) && id.ValueKind == JsonValueKind.String
            ? id.GetString() : null;
        if (path is not null && (string.IsNullOrWhiteSpace(path) || string.IsNullOrWhiteSpace(analysisId)))
            throw new InvalidDataException("Extraction packages must include a path and analysis ID.");
        return (path, analysisId);
    }

    private static bool TryGetPropertyIgnoreCase(JsonElement element, string propertyName,
        out JsonElement value)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in element.EnumerateObject())
            {
                if (string.Equals(property.Name, propertyName, StringComparison.OrdinalIgnoreCase))
                {
                    value = property.Value;
                    return true;
                }
            }
        }
        value = default;
        return false;
    }

    internal static string ProgressPartitionKey(string accountId, string identifier) =>
        "v2-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(accountId + "\n" + identifier)));

    public async ValueTask DisposeAsync()
    {
        cosmos.Dispose();
        await publisher.DisposeAsync();
    }
}
