using System.Globalization;
using System.Text.Json.Serialization;
using Azure.Messaging.EventHubs;

namespace FileOperations;

public sealed record EventOrder(
    [property: JsonPropertyName("enqueuedTicks")] string EnqueuedTicks,
    [property: JsonPropertyName("partitionId")] string PartitionId,
    [property: JsonPropertyName("sequenceNumber")] string SequenceNumber)
{
    public static EventOrder From(EventData data, string partitionId) => new(
        data.EnqueuedTime.UtcDateTime.Ticks.ToString(CultureInfo.InvariantCulture),
        partitionId,
        data.SequenceNumber.ToString(CultureInfo.InvariantCulture));
}
