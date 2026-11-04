using System.Text.Json;
using System.Text.Json.Nodes;
using Azure.Identity;
using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Producer;

namespace FileOperations;

public sealed class IngestionEventPublisher : IAsyncDisposable
{
    private readonly EventHubProducerClient producer;

    public IngestionEventPublisher() : this(new EventHubProducerClient(
        Settings.Required("EVENTHUB_NAMESPACE"), Settings.Get("EVENTHUB_NAME") ?? "file-operations",
        new DefaultAzureCredential(), new EventHubProducerClientOptions
        {
            ConnectionOptions = Settings.EventHubConnectionOptions()
        })) { }

    internal IngestionEventPublisher(EventHubProducerClient producer) => this.producer = producer;

    public async Task PublishAsync(JsonElement work, string eventKind, CancellationToken cancellationToken)
    {
        var content = JsonNode.Parse(work.GetRawText())!.AsObject();
        content["eventKind"] = eventKind;
        var body = JsonSerializer.SerializeToUtf8Bytes(new { contentData = content });
        await producer.SendAsync([new EventData(body)], new SendEventOptions
        {
            PartitionKey = EventPartitioning.ForSource(work.GetProperty("accountId").GetString()!,
                work.GetProperty("sourceId").GetString()!)
        }, cancellationToken);
    }

    public ValueTask DisposeAsync() => producer.DisposeAsync();
}
