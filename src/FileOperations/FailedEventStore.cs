using System.Text.Json;
using Azure.Storage.Blobs;

namespace FileOperations;

public sealed record FailedEvent(string Role, string PartitionId, long SequenceNumber,
    string Offset, string EventKind, string ErrorType, BinaryData EventBody);

public interface IFailedEventStore
{
    Task<string> SaveAsync(FailedEvent failedEvent, CancellationToken cancellationToken);
}

public sealed class BlobFailedEventStore : IFailedEventStore
{
    private readonly BlobContainerClient container = Settings.StorageBlobs("CHECKPOINT_STORAGE_CONNECTION_STRING").GetBlobContainerClient(
        Settings.Get("FAILED_EVENTS_CONTAINER") ?? "file-operations-failed-events");

    public async Task<string> SaveAsync(FailedEvent failedEvent, CancellationToken cancellationToken)
    {
        var sequence = failedEvent.SequenceNumber.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var blobName = $"{failedEvent.Role}/{failedEvent.PartitionId}/{sequence}.json";
        var record = BinaryData.FromBytes(JsonSerializer.SerializeToUtf8Bytes(new
        {
            role = failedEvent.Role, partitionId = failedEvent.PartitionId,
            sequenceNumber = failedEvent.SequenceNumber, offsetString = failedEvent.Offset,
            eventKind = failedEvent.EventKind, failedAt = DateTimeOffset.UtcNow,
            errorType = failedEvent.ErrorType,
            eventBodyBase64 = Convert.ToBase64String(failedEvent.EventBody.ToMemory().Span)
        }));
        await container.CreateIfNotExistsAsync(cancellationToken: cancellationToken);
        await container.GetBlobClient(blobName).UploadAsync(record, overwrite: true, cancellationToken);
        return blobName;
    }
}
