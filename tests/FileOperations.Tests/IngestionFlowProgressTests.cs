using System.Net;
using System.Text;
using System.Text.Json;
using Azure.Core;
using Azure.Data.Tables;
using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Producer;
using FileOperations;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Logging;
using Xunit;

namespace FileOperations.Tests;

[Collection(nameof(EnvironmentSettingsCollection))]
public class IngestionFlowProgressTests
{
    private const string Account = "acct";
    private const string Identifier = "file";
    private const string Source = "6";
    private static readonly EventOrder Order = new("639287043700000000", "2", "5");
    private static readonly string Partition = IngestionFlow.ProgressPartitionKey(Account, Identifier);
    private static readonly string Row = IngestionProgress.RowKey("123", Order);
    private static JsonElement Content => JsonSerializer.SerializeToElement(new
        { accountId = Account, identifier = Identifier, isFolder = false });

    [Theory]
    [InlineData("Completed", true)]
    [InlineData("Completed", false)]
    [InlineData("AwaitingEvidence", true)]
    [InlineData("AwaitingEvidence", false)]
    [InlineData("Stopped", true)]
    [InlineData("Stopped", false)]
    public async Task TerminalJobIsSkippedWithExactIdentityEvenWithoutSavedWork(string status, bool savedWork)
    {
        var original = SavedProgress(status);
        if (!savedWork) original.Remove("Work");
        using var store = new ProgressStore(original);
        using var http = new HttpClient(new RejectRequests());
        var log = new RecordingLogger();
        var producer = new RecordingProducer();
        await using var flow = Flow(store, http, producer, log);

        await flow.ProcessAsync(Content, "123", Order, CancellationToken.None);

        Assert.Single(store.Reads);
        Assert.Empty(store.Writes);
        Assert.Empty(store.MarkerReads);
        Assert.Empty(producer.Events);
        Assert.Contains(log.States, state => Equals(state.GetValueOrDefault("jobId"), Partition + ":" + Row)
            && Equals(state.GetValueOrDefault("RuntimeStatus"), status));
    }

    [Fact]
    public async Task ResumeAndStopHandlingUseExactJobAndSavedSource()
    {
        var original = SavedProgress("Running");
        original.Remove("SourceId"); // Catch path must recover the source from Work.
        using var store = new ProgressStore(original);
        var marker = "/tasks/" + IngestionStopStore.MarkerPath(Account, Source, Partition + ":" + Row);
        store.Markers.Add(marker);
        using var http = new HttpClient(new RejectRequests());
        var producer = new RecordingProducer();
        await using var flow = Flow(store, http, producer);

        await flow.ProcessAsync(Content, "123", Order, CancellationToken.None);

        Assert.NotEmpty(store.Writes);
        Assert.All(store.Writes, key => Assert.Equal((Partition, Row), key));
        Assert.Equal("Stopped", store.Row(Partition, Row).GetString("RuntimeStatus"));
        Assert.Equal(2, store.MarkerReads.Count);
        Assert.All(store.MarkerReads, path => Assert.Equal(marker, path));
        Assert.Empty(producer.Events);
    }

    [Fact]
    public async Task SavedWorkResumesWithSameJobThroughEvidenceHandoff()
    {
        using var settings = new FlowSettings();
        var original = SavedProgress("Running");
        original["PreliminaryNotified"] = true;
        using var store = new ProgressStore(original);
        var handler = new IngestionRequests();
        using var http = new HttpClient(handler);
        var producer = new RecordingProducer();
        await using var flow = Flow(store, http, producer);

        await flow.ProcessAsync(Content, "123", Order, CancellationToken.None);

        Assert.All(store.Writes, key => Assert.Equal((Partition, Row), key));
        Assert.Equal("AwaitingEvidence", store.Row(Partition, Row).GetString("RuntimeStatus"));
        var submitted = Assert.Single(handler.Bodies);
        Assert.Equal(Partition + ":" + Row, submitted.GetProperty("jobId").GetString());
        var published = Assert.Single(producer.Events).GetProperty("contentData");
        Assert.Equal(Partition, published.GetProperty("progressPartition").GetString());
        Assert.Equal(Row, published.GetProperty("progressRow").GetString());
        Assert.Equal(Partition + ":" + Row, published.GetProperty("jobId").GetString());
        Assert.All(store.MarkerReads, path => Assert.Equal("/tasks/" +
            IngestionStopStore.MarkerPath(Account, Source, Partition + ":" + Row), path));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task FreshEventUsesOneLookupAndIgnoresOldSchemaAndOtherPartitions(bool oldSchema)
    {
        using var settings = new FlowSettings();
        var original = SavedProgress("Completed");
        original.RowKey = oldSchema ? "5:123" : IngestionProgress.RowKey("123", Order with { PartitionId = "9" });
        original.Remove("Work");
        using var store = new ProgressStore(original);
        var handler = new GeneratedFileRequests();
        using var http = new HttpClient(handler);
        var producer = new RecordingProducer();
        await using var flow = Flow(store, http, producer);

        await flow.ProcessAsync(Content, "123", Order, CancellationToken.None);

        var read = Assert.Single(store.Reads);
        Assert.Contains("RowKey='" + Row + "'", read);
        Assert.Equal(2, handler.Requests);
        Assert.All(store.Writes, key => Assert.Equal((Partition, Row), key));
        Assert.Equal("Completed", store.Row(Partition, Row).GetString("RuntimeStatus"));
        Assert.Equal("Completed", store.Row(Partition, original.RowKey).GetString("RuntimeStatus"));
        Assert.Empty(producer.Events);
    }

    [Fact]
    public async Task CleanupUsesSavedJobIdentity()
    {
        using var store = new ProgressStore(SavedProgress("AwaitingEvidence"));
        using var http = new HttpClient(new RejectRequests());
        await using var flow = Flow(store, http, new RecordingProducer());
        var cleanup = System.Text.Json.Nodes.JsonNode.Parse(Work().GetRawText())!;
        cleanup["status"] = "SUPERSEDED";

        await flow.CleanupAsync(JsonSerializer.SerializeToElement(cleanup), CancellationToken.None);

        Assert.Single(store.Reads);
        Assert.Equal((Partition, Row), Assert.Single(store.Writes));
        Assert.Equal("Completed", store.Row(Partition, Row).GetString("RuntimeStatus"));
    }

    [Fact]
    public async Task MissingEventOrderIsRejectedBeforeStorageAccess()
    {
        using var store = new ProgressStore();
        using var http = new HttpClient(new RejectRequests());
        await using var flow = Flow(store, http, new RecordingProducer());
        await Assert.ThrowsAsync<ArgumentNullException>(() => flow.ProcessAsync(Content, "123", null!, CancellationToken.None));
        Assert.Empty(store.Reads);
    }

    private static TableEntity SavedProgress(string status) => new(Partition, Row)
    {
        ["RuntimeStatus"] = status, ["AccountId"] = Account, ["SourceId"] = Source,
        ["Identifier"] = Identifier, ["Work"] = Work().GetRawText()
    };

    private static JsonElement Work() => JsonSerializer.SerializeToElement(new
    {
        eventOrder = Order, accountId = Account, identifier = Identifier, sourceId = Source,
        progressPartition = Partition, progressRow = Row, jobId = Partition + ":" + Row,
        cleanupBlobs = Array.Empty<object>()
    });

    private static IngestionFlow Flow(ProgressStore store, HttpClient http, RecordingProducer producer,
        RecordingLogger? logger = null) => new(http, new HttpFunctions(http), new NotificationClient(http), logger,
        new TestCredential(), store.Client, store.Blobs,
        new CosmosClient("https://cosmos.example", Convert.ToBase64String(new byte[64])),
        new IngestionEventPublisher(producer), new IngestionStopStore(store.Client, store.Blobs.GetBlobContainerClient("tasks")),
        new NoRecipients());

    private sealed class NoRecipients : INotificationRecipientStore
    {
        public Task<IReadOnlyList<string>> GetRecipientsAsync(string accountId, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<string>>([]);
    }

    private sealed class TestCredential : TokenCredential
    {
        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            new("test", DateTimeOffset.UtcNow.AddHours(1));
        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            ValueTask.FromResult(GetToken(requestContext, cancellationToken));
    }

    private sealed class RecordingProducer : EventHubProducerClient
    {
        public List<JsonElement> Events { get; } = [];
        public override Task SendAsync(IEnumerable<EventData> eventBatch, SendEventOptions sendOptions,
            CancellationToken cancellationToken = default)
        {
            Events.AddRange(eventBatch.Select(data => JsonSerializer.Deserialize<JsonElement>(data.EventBody)));
            return Task.CompletedTask;
        }
        public override ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class RejectRequests : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("Unexpected outbound request: " + request.RequestUri);
    }

    private sealed class IngestionRequests : HttpMessageHandler
    {
        public List<JsonElement> Bodies { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.Equal("/internal/data-ingestion/ingest", request.RequestUri!.AbsolutePath);
            Bodies.Add(JsonSerializer.Deserialize<JsonElement>(await request.Content!.ReadAsStringAsync(cancellationToken)));
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}", Encoding.UTF8, "application/json") };
        }
    }

    private sealed class GeneratedFileRequests : HttpMessageHandler
    {
        public int Requests { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests++;
            var body = Requests switch
            {
                1 => """{"id":"site"}""",
                2 => """{"id":"file","name":"generated.pdf","sharepointIds":{"listItemId":"6"},"parentReference":{"path":"/drive/root:/_GeneratedDocuments"}}""",
                _ => throw new InvalidOperationException("Generated files must not be downloaded or ingested")
            };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    private sealed class RecordingLogger : ILogger<IngestionFlow>
    {
        public List<Dictionary<string, object?>> States { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (state is IEnumerable<KeyValuePair<string, object?>> properties) States.Add(properties.ToDictionary());
        }
    }

    private sealed class FlowSettings : IDisposable
    {
        private readonly Dictionary<string, string?> previous;
        public FlowSettings()
        {
            var settings = new Dictionary<string, string>
            {
                ["DATA_INGESTION_SERVICE_URL"] = "https://ingestion.example",
                ["SHAREPOINT_HOST"] = "contoso.sharepoint.com",
                ["SHAREPOINT_IDENTIFIER_MODE"] = "drive_id"
            };
            previous = settings.ToDictionary(pair => pair.Key, pair => Environment.GetEnvironmentVariable(pair.Key));
            foreach (var pair in settings) Environment.SetEnvironmentVariable(pair.Key, pair.Value);
        }
        public void Dispose()
        {
            foreach (var pair in previous) Environment.SetEnvironmentVariable(pair.Key, pair.Value);
        }
    }
}
