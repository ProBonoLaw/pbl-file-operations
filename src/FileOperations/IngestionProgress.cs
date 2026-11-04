namespace FileOperations;

internal static class IngestionProgress
{
    // Sequence numbers and offsets are only unique within one Event Hub partition.
    // Enqueue time also distinguishes events after a hub is recreated.
    internal static string RowKey(string offset, EventOrder order)
    {
        ArgumentNullException.ThrowIfNull(order);
        return $"v2:{order.PartitionId}:{order.EnqueuedTicks}:{order.SequenceNumber}:{offset}";
    }
}
