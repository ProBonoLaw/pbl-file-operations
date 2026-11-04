using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Azure;
using Azure.Data.Tables;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

namespace FileOperations;

/// <summary>A durable, request-scoped stop shared with the evidence task workers.</summary>
public sealed class IngestionStopStore : IIngestionStopStore
{
    private static readonly Regex JobPattern = new(@"^(v2-[A-F0-9]{64}):(.+)$", RegexOptions.Compiled);
    private readonly TableClient progress;
    private readonly BlobContainerClient markers;

    public IngestionStopStore() : this(
        Settings.StorageTables().GetTableClient(Settings.Get("TABLE_NAME") ?? "IngestionProgress"),
        Settings.StorageBlobs().GetBlobContainerClient(Settings.Get("EVIDENCE_TASK_CONTAINER") ?? "file-operations-evidence-tasks")) { }

    internal IngestionStopStore(TableClient progress, BlobContainerClient markers)
    {
        this.progress = progress;
        this.markers = markers;
    }

    public async Task<StopRequestResult> RequestAsync(string accountId, string sourceId, string jobId,
        CancellationToken cancellationToken)
    {
        var match = JobPattern.Match(jobId);
        if (!match.Success) return StopRequestResult.Invalid;
        var found = await progress.GetEntityIfExistsAsync<TableEntity>(match.Groups[1].Value,
            match.Groups[2].Value, cancellationToken: cancellationToken);
        if (!found.HasValue) return StopRequestResult.NotFound;
        var entity = found.Value!;
        var savedAccount = entity.GetString("AccountId");
        var savedSource = entity.GetString("SourceId");
        if (entity.GetString("Work") is { } savedWork)
        {
            using var work = JsonDocument.Parse(savedWork);
            savedAccount = work.RootElement.GetProperty("accountId").GetString();
            savedSource = work.RootElement.GetProperty("sourceId").GetString();
            if (work.RootElement.GetProperty("jobId").GetString() != jobId)
                return StopRequestResult.NotFound;
        }
        if (savedAccount != accountId || savedSource != sourceId) return StopRequestResult.NotFound;
        if (entity.GetString("RuntimeStatus") == "Completed") return StopRequestResult.Completed;
        if (entity.GetBoolean("StopRequested") == true) return StopRequestResult.AlreadyRequested;

        // Fence the evidence workers first. A repeated request can finish the
        // table update if the first caller lost its response in between writes.
        await markers.CreateIfNotExistsAsync(cancellationToken: cancellationToken);
        var marker = markers.GetBlobClient(MarkerPath(accountId, sourceId, jobId));
        try
        {
            await marker.UploadAsync(BinaryData.FromObjectAsJson(new
            {
                accountId, sourceId, jobId, reason = "operator requested ingestion stop",
                stoppedAt = DateTimeOffset.UtcNow
            }), new BlobUploadOptions { Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All } },
                cancellationToken);
        }
        catch (RequestFailedException error) when (error.Status is 409 or 412) { }

        await progress.UpsertEntityAsync(new TableEntity(entity.PartitionKey, entity.RowKey)
        {
            ["StopRequested"] = true,
            ["StopRequestedAt"] = DateTimeOffset.UtcNow
        }, TableUpdateMode.Merge, cancellationToken);
        return StopRequestResult.Accepted;
    }

    public async Task<bool> IsStoppedAsync(string accountId, string sourceId, string jobId,
        CancellationToken cancellationToken) =>
        await markers.GetBlobClient(MarkerPath(accountId, sourceId, jobId)).ExistsAsync(cancellationToken);

    public static string MarkerPath(string accountId, string sourceId, string jobId)
    {
        if (string.IsNullOrWhiteSpace(accountId) || string.IsNullOrWhiteSpace(sourceId) ||
            string.IsNullOrWhiteSpace(jobId)) throw new ArgumentException("Account, source, and job are required");
        var identity = JsonSerializer.Serialize(new[] { accountId, sourceId, jobId });
        return "stopped-jobs/" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(identity))) + ".json";
    }

    public async Task RunUntilStoppedAsync(string accountId, string sourceId, string jobId,
        Func<CancellationToken, Task> action, CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        await AssertOpenAsync(accountId, sourceId, jobId, linked.Token);
        var monitor = MonitorAsync();
        try
        {
            await action(linked.Token);
            await AssertOpenAsync(accountId, sourceId, jobId, linked.Token);
        }
        finally
        {
            linked.Cancel();
            await monitor;
        }

        async Task MonitorAsync()
        {
            try
            {
                using var timer = new PeriodicTimer(TimeSpan.FromSeconds(3));
                while (await timer.WaitForNextTickAsync(linked.Token))
                    if (await IsStoppedAsync(accountId, sourceId, jobId, linked.Token))
                    {
                        linked.Cancel();
                        return;
                    }
            }
            catch (OperationCanceledException) when (linked.IsCancellationRequested) { }
            catch
            {
                linked.Cancel();
                throw;
            }
        }
    }

    public async Task AssertOpenAsync(string accountId, string sourceId, string jobId,
        CancellationToken cancellationToken)
    {
        if (await IsStoppedAsync(accountId, sourceId, jobId, cancellationToken))
            throw new OperationCanceledException("Ingestion job was stopped", cancellationToken);
    }
}

public enum StopRequestResult { Accepted, AlreadyRequested, Invalid, NotFound, Completed }
