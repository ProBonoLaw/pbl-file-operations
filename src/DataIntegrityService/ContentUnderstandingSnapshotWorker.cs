using Azure;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Azure.Storage.Blobs.Specialized;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

/// <summary>Reconcile snapshot receipts even when the HTTP caller never retries its timed-out analysis.</summary>
public sealed class ContentUnderstandingSnapshotWorker(BlobServiceClient blobs, DataIntegrityOptions options,
    IConfiguration configuration, IHttpClientFactory httpClients, ILogger<ContentUnderstandingSnapshotWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Default legacy installations do not need to scan a CU journal container.
        if (string.IsNullOrWhiteSpace(configuration["CONTENT_UNDERSTANDING_ENDPOINT"])) return;
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await SweepAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            catch (Exception error) { logger.LogWarning("CU snapshot reconciliation will retry; failure type {FailureType}.", error.GetType().Name); }
            await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken);
        }
    }

    public async Task SweepAsync(CancellationToken cancellationToken)
    {
        await foreach (var item in blobs.GetBlobContainerClient(options.OutputContainer).GetBlobsAsync(
            BlobTraits.Metadata, BlobStates.None, prefix: "cu-operations/", cancellationToken: cancellationToken))
        {
            if (!item.Metadata.TryGetValue("cuSnapshotPending", out string? pending) || pending != "true") continue;
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(TimeSpan.FromSeconds(20)); // Shorter than the lease; no renewer is needed for one reconciliation.
            try { await ReconcileAsync(blobs.GetBlobContainerClient(options.OutputContainer).GetBlobClient(item.Name), deadline.Token); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (Exception error) { logger.LogWarning("CU snapshot receipt remains pending; failure type {FailureType}.", error.GetType().Name); }
        }
    }

    private async Task ReconcileAsync(BlobClient journal, CancellationToken cancellationToken)
    {
        var lease = journal.GetBlobLeaseClient();
        try { await lease.AcquireAsync(TimeSpan.FromSeconds(60), cancellationToken: cancellationToken); }
        catch (RequestFailedException error) when (error.Status is 409 or 412) { return; }
        try
        {
            var store = new BlobCuOperationStore(journal, lease.LeaseId);
            var operation = await store.ReadAsync(cancellationToken);
            if (operation?.Phase == "polling")
            {
                var client = new ContentUnderstandingClient(httpClients.CreateClient("content-understanding"), ContentUnderstandingOptions.Read(configuration));
                var (refreshed, _) = await client.RefreshAsync(operation, cancellationToken);
                if (refreshed.Phase != "polling") await store.SaveAsync(refreshed, cancellationToken);
            }
            await ContentUnderstandingSnapshots.CleanupAsync(blobs, store, cancellationToken);
        }
        finally
        {
            using var release = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await lease.ReleaseAsync(cancellationToken: release.Token);
        }
    }
}
