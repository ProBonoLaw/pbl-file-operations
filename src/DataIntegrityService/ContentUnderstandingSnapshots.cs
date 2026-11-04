using Azure;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

public static class ContentUnderstandingSnapshots
{
    private const string OwnerMetadata = "cuSnapshotOwner";

    public static async Task<CuOperation> PrepareAsync(BlobServiceClient blobs, ICuOperationStore store,
        DocumentRequest request, string sourceHash, ETag etag, CancellationToken cancellationToken)
    {
        var operation = await store.ReadAsync(cancellationToken);
        // Existing paid operations, including legacy journals without a snapshot receipt, need no new snapshot.
        if (operation is not null && operation.Phase != "prepared") return operation;
        if (operation?.Source is null)
        {
            operation = new("prepared", Source: new(request.ContainerName!, request.ContainerPath!, sourceHash,
                etag.ToString(), Guid.NewGuid().ToString("N")));
            // Persist creation intent before the storage mutation. A lost response can be recovered by its owner metadata.
            await store.SaveAsync(operation, cancellationToken);
        }
        if (operation.Source!.SourceSha256 != sourceHash) throw new InvalidDataException("CU snapshot source hash differs from this operation.");
        if (operation.Source.Snapshot is not null) return operation;
        var owned = await FindOwnedAsync(blobs, operation.Source, cancellationToken);
        string snapshot;
        if (owned.Count > 0) snapshot = owned[0];
        else
        {
            var source = blobs.GetBlobContainerClient(operation.Source.ContainerName).GetBlobClient(operation.Source.ContainerPath);
            var created = await source.CreateSnapshotAsync(new Dictionary<string, string> { [OwnerMetadata] = operation.Source.OwnerId },
                new BlobRequestConditions { IfMatch = new ETag(operation.Source.ETag) }, cancellationToken);
            snapshot = created.Value.Snapshot;
        }
        operation = operation with { Source = operation.Source with { Snapshot = snapshot } };
        await store.SaveAsync(operation, cancellationToken);
        return operation;
    }

    public static async Task CleanupAsync(BlobServiceClient blobs, ICuOperationStore store, CancellationToken cancellationToken)
    {
        var operation = await store.ReadAsync(cancellationToken);
        // Local timeouts, uncertain POST outcomes, HTTP/polling errors, and running operations are not terminal.
        if (operation?.Source is not { } receipt || operation.Phase is not ("prepared" or "succeeded" or "failed")) return;
        var source = blobs.GetBlobContainerClient(receipt.ContainerName).GetBlobClient(receipt.ContainerPath);
        var snapshots = (await FindOwnedAsync(blobs, receipt, cancellationToken)).ToHashSet(StringComparer.Ordinal);
        if (receipt.Snapshot is not null) snapshots.Add(receipt.Snapshot);
        foreach (string snapshot in snapshots)
            await source.WithSnapshot(snapshot).DeleteIfExistsAsync(cancellationToken: cancellationToken);
        // Delete first, clear the receipt second. An interrupted cleanup is idempotent and retried by the worker.
        await store.SaveAsync(operation with { Source = null }, cancellationToken);
    }

    private static async Task<List<string>> FindOwnedAsync(BlobServiceClient blobs, CuSourceSnapshot receipt,
        CancellationToken cancellationToken)
    {
        var snapshots = new List<string>();
        await foreach (var item in blobs.GetBlobContainerClient(receipt.ContainerName).GetBlobsAsync(
            BlobTraits.Metadata, BlobStates.Snapshots, receipt.ContainerPath, cancellationToken))
            if (item.Name == receipt.ContainerPath && item.Snapshot is not null &&
                item.Metadata.TryGetValue(OwnerMetadata, out string? owner) && owner == receipt.OwnerId)
                snapshots.Add(item.Snapshot);
        return snapshots;
    }
}
