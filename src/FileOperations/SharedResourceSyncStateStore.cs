using System.Text.Json;
using Azure;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;

namespace FileOperations;

public sealed record SharedResourceSyncState(string DeltaLink, string[] FolderIds);

public sealed record StoredSharedResourceSyncState(SharedResourceSyncState State, ETag ETag);

public sealed class SharedResourceSyncStateStore
{
    private readonly BlobContainerClient container = Settings.StorageBlobs("CHECKPOINT_STORAGE_CONNECTION_STRING").GetBlobContainerClient(
        Settings.Get("SHARED_RESOURCE_SYNC_STATE_CONTAINER") ?? "file-operations-sync-state");

    public async Task EnsureReadyAsync(CancellationToken cancellationToken) =>
        await container.CreateIfNotExistsAsync(cancellationToken: cancellationToken);

    public async Task<StoredSharedResourceSyncState?> ReadAsync(string accountId,
        CancellationToken cancellationToken)
    {
        try
        {
            var download = await Blob(accountId).DownloadContentAsync(cancellationToken);
            var state = JsonSerializer.Deserialize<SharedResourceSyncState>(
                download.Value.Content.ToMemory().Span);
            if (state is null || string.IsNullOrWhiteSpace(state.DeltaLink) || state.FolderIds is null)
                throw new InvalidDataException("Shared-resource sync state is invalid");
            return new StoredSharedResourceSyncState(state, download.Value.Details.ETag);
        }
        catch (RequestFailedException error) when (error.Status == 404)
        {
            return null;
        }
    }

    public async Task SaveAsync(string accountId, SharedResourceSyncState state, ETag? currentETag,
        CancellationToken cancellationToken)
    {
        var conditions = currentETag.HasValue
            ? new BlobRequestConditions { IfMatch = currentETag.Value }
            : new BlobRequestConditions { IfNoneMatch = ETag.All };
        await Blob(accountId).UploadAsync(BinaryData.FromBytes(JsonSerializer.SerializeToUtf8Bytes(state)),
            new BlobUploadOptions { Conditions = conditions }, cancellationToken);
    }

    private BlobClient Blob(string accountId) => container.GetBlobClient($"accounts/{accountId}.json");
}
