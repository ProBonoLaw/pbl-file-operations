using System.Net;
using System.Text;
using System.Text.Json;
using Azure;
using Azure.Core.Pipeline;
using Azure.Storage.Blobs;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FileOperations.Tests;

public class ContentUnderstandingSnapshotTests
{
    private static readonly DocumentRequest Request = new("source.mp4", "source.mp4", "source", "account", "input", "raw-guid");
    private static readonly string SourceHash = new('a', 64);
    private const string OperationUrl = "https://analysis.example/contentunderstanding/analyzerResults/one?api-version=2025-11-01";
    private static CuSourceSnapshot Receipt(string? snapshot = "2026-10-12T00:00:00.0000000Z")
        => new("input", "raw-guid", SourceHash, "\"source-version\"", "owner", snapshot);
    private static ContentUnderstandingOptions Options(TimeSpan? timeout = null) =>
        new(new("https://analysis.example/"), "test-key", "test", "test", "test", "geography", "1", null, timeout ?? TimeSpan.FromSeconds(5));
    private static BlobServiceClient Blobs(HttpClient http) => new(new Uri("https://storage.example/"),
        new BlobClientOptions { Transport = new HttpClientTransport(http), Retry = { MaxRetries = 0 } });

    [Fact]
    public async Task PersistsOwnershipBeforeCreatingSnapshotAndReusesIt()
    {
        using var handler = new StorageHandler();
        using var http = new HttpClient(handler);
        var store = new MemoryStore();
        handler.BeforeCreate = () =>
        {
            Assert.Equal("prepared", store.State!.Phase);
            Assert.NotNull(store.State.Source);
            Assert.Null(store.State.Source.Snapshot);
        };
        var first = await ContentUnderstandingSnapshots.PrepareAsync(Blobs(http), store, Request, SourceHash, new("\"source-version\""), CancellationToken.None);
        var second = await ContentUnderstandingSnapshots.PrepareAsync(Blobs(http), store, Request, SourceHash, new("\"source-version\""), CancellationToken.None);
        Assert.Equal(first.Source!.Snapshot, second.Source!.Snapshot);
        Assert.Equal(1, handler.Creates);
        Assert.Equal(SourceHash, first.Source.SourceSha256);
    }

    [Fact]
    public async Task RecoversCreatedSnapshotWhenSavingItsIdWasInterrupted()
    {
        using var handler = new StorageHandler();
        using var http = new HttpClient(handler);
        var store = new MemoryStore { RejectSnapshotSaveOnce = true };
        await Assert.ThrowsAsync<IOException>(() => ContentUnderstandingSnapshots.PrepareAsync(Blobs(http), store,
            Request, SourceHash, new("\"source-version\""), CancellationToken.None));
        Assert.Null(store.State!.Source!.Snapshot);
        var resumed = await ContentUnderstandingSnapshots.PrepareAsync(Blobs(http), store,
            Request, SourceHash, new("\"source-version\""), CancellationToken.None);
        Assert.Equal(handler.Snapshots.Single().Snapshot, resumed.Source!.Snapshot);
        Assert.Equal(1, handler.Creates);
    }

    [Theory]
    [InlineData("polling", true)]
    [InlineData("submitting", true)]
    [InlineData("failed", true)]
    [InlineData("succeeded", true)]
    [InlineData("polling", false)] // Pre-migration journal without a receipt.
    public async Task PaidOperationRetriesNeverCreateAnotherSnapshot(string phase, bool hasReceipt)
    {
        using var handler = new StorageHandler();
        using var http = new HttpClient(handler);
        var store = new MemoryStore { State = new(phase, OperationUrl, Source: hasReceipt ? Receipt() : null) };
        var state = await ContentUnderstandingSnapshots.PrepareAsync(Blobs(http), store,
            Request, SourceHash, new("\"new-input-version\""), CancellationToken.None);
        Assert.Equal(phase, state.Phase);
        Assert.Equal(0, handler.Creates);
        Assert.Equal(0, handler.Reads);
    }

    [Theory]
    [InlineData("prepared")]
    [InlineData("succeeded")]
    [InlineData("failed")]
    public async Task DeletesOnlyOwnedSnapshotsAndClearsReceiptAfterDeletion(string phase)
    {
        using var handler = new StorageHandler();
        handler.Snapshots.Add((Receipt().Snapshot!, "owner", "raw-guid"));
        handler.Snapshots.Add(("2026-10-12T00:00:01.0000000Z", "different-owner", "raw-guid"));
        handler.Snapshots.Add(("2026-10-12T00:00:02.0000000Z", "owner", "raw-guid-other"));
        using var http = new HttpClient(handler);
        var store = new MemoryStore { State = new(phase, OperationUrl, Source: Receipt()) };
        handler.BeforeDelete = () => Assert.NotNull(store.State!.Source);
        await ContentUnderstandingSnapshots.CleanupAsync(Blobs(http), store, CancellationToken.None);
        Assert.Null(store.State!.Source);
        Assert.Equal(1, handler.Deletes);
        Assert.Equal(2, handler.Snapshots.Count);
        await ContentUnderstandingSnapshots.CleanupAsync(Blobs(http), store, CancellationToken.None);
        Assert.Equal(1, handler.Deletes);
    }

    [Theory]
    [InlineData("polling")]
    [InlineData("submitting")]
    public async Task NeverDeletesPotentiallyRunningSources(string phase)
    {
        using var handler = new StorageHandler();
        using var http = new HttpClient(handler);
        var store = new MemoryStore { State = new(phase, OperationUrl, Source: Receipt()) };
        await ContentUnderstandingSnapshots.CleanupAsync(Blobs(http), store, CancellationToken.None);
        Assert.NotNull(store.State!.Source);
        Assert.Equal(0, handler.Deletes);
        Assert.Equal(0, handler.Reads);
    }

    [Fact]
    public async Task FailedCleanupRetainsReceiptForRetry()
    {
        using var handler = new StorageHandler { FailDelete = true };
        handler.Snapshots.Add((Receipt().Snapshot!, "owner", "raw-guid"));
        using var http = new HttpClient(handler);
        var store = new MemoryStore { State = new("failed", Source: Receipt()) };
        await Assert.ThrowsAsync<RequestFailedException>(() => ContentUnderstandingSnapshots.CleanupAsync(Blobs(http), store, CancellationToken.None));
        Assert.NotNull(store.State!.Source);
        handler.FailDelete = false;
        await ContentUnderstandingSnapshots.CleanupAsync(Blobs(http), store, CancellationToken.None);
        Assert.Null(store.State!.Source);
    }

    [Theory]
    [InlineData(400, "failed")]
    [InlineData(429, "failed")]
    [InlineData(408, "submitting")]
    [InlineData(500, "submitting")]
    [InlineData(503, "submitting")]
    public async Task SubmissionOutcomePreservesSnapshotAndDistinguishesRejectionFromUncertainty(int status, string phase)
    {
        using var handler = new AnalysisHandler { PostStatus = (HttpStatusCode)status };
        using var http = new HttpClient(handler);
        var store = new MemoryStore { State = new("prepared", Source: Receipt()) };
        await Assert.ThrowsAsync<HttpRequestException>(() => new ContentUnderstandingClient(http, Options()).AnalyzeAsync("test", "https://storage/source", store, CancellationToken.None));
        Assert.Equal(phase, store.State!.Phase);
        Assert.Equal(Receipt(), store.State.Source);
    }

    [Fact]
    public async Task LocalPollingTimeoutKeepsSnapshotAndRetryOnlyGetsTerminalResult()
    {
        using var handler = new AnalysisHandler { OperationStatus = "running" };
        using var http = new HttpClient(handler);
        var store = new MemoryStore { State = new("prepared", Source: Receipt()) };
        await Assert.ThrowsAsync<TimeoutException>(() => new ContentUnderstandingClient(http, Options(TimeSpan.FromMilliseconds(1)))
            .AnalyzeAsync("test", "https://storage/source", store, CancellationToken.None));
        Assert.Equal("polling", store.State!.Phase);
        Assert.NotNull(store.State.Source);
        handler.OperationStatus = "succeeded";
        await new ContentUnderstandingClient(http, Options()).AnalyzeAsync("test", "unused", store, CancellationToken.None);
        Assert.Equal("succeeded", store.State!.Phase);
        Assert.Equal(Receipt(), store.State.Source);
        Assert.Equal(1, handler.Posts);
    }

    [Theory]
    [InlineData(true, "submitting")]
    [InlineData(false, "polling")]
    public async Task CancellationDuringSubmissionOrPollingPreservesPotentiallyRunningSource(bool cancelPost, string phase)
    {
        using var cancellation = new CancellationTokenSource();
        using var handler = new AnalysisHandler { BeforeRequest = request =>
        {
            if ((cancelPost && request.Method == HttpMethod.Post) ||
                (!cancelPost && request.RequestUri!.AbsolutePath.Contains("analyzerResults"))) cancellation.Cancel();
        } };
        using var http = new HttpClient(handler);
        var store = new MemoryStore { State = new("prepared", Source: Receipt()) };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new ContentUnderstandingClient(http, Options())
            .AnalyzeAsync("test", "https://storage/source", store, cancellation.Token));
        Assert.Equal(phase, store.State!.Phase);
        Assert.Equal(Receipt(), store.State.Source);
        using var storageHandler = new StorageHandler();
        using var storage = new HttpClient(storageHandler);
        await ContentUnderstandingSnapshots.CleanupAsync(Blobs(storage), store, CancellationToken.None);
        Assert.Equal(0, storageHandler.Deletes);
    }

    [Theory]
    [InlineData("failed")]
    [InlineData("canceled")]
    public async Task TerminalFailureRetainsReceiptForCleanup(string status)
    {
        using var handler = new AnalysisHandler { OperationStatus = status };
        using var http = new HttpClient(handler);
        var store = new MemoryStore { State = new("polling", OperationUrl, Source: Receipt()) };
        await Assert.ThrowsAsync<DaatPhoenix.DataIntegrity.AI.DataIntegrity.Exceptions.UnprocessableDocumentException>(() =>
            new ContentUnderstandingClient(http, Options()).AnalyzeAsync("test", "unused", store, CancellationToken.None));
        Assert.Equal("failed", store.State!.Phase);
        Assert.Equal(Receipt(), store.State.Source);
        Assert.NotNull(store.State.Response);
        Assert.Equal(0, handler.Posts);
    }

    [Theory]
    [InlineData("running", false)]
    [InlineData("succeeded", true)]
    [InlineData("failed", true)]
    public async Task WorkerReconcilesAbandonedPollingOperationWithoutSubmittingAgain(string status, bool deleted)
    {
        using var handler = new StorageHandler { Journal = new("polling", OperationUrl, Source: Receipt()) };
        handler.Snapshots.Add((Receipt().Snapshot!, "owner", "raw-guid"));
        using var storage = new HttpClient(handler);
        using var analysisHandler = new AnalysisHandler { OperationStatus = status };
        using var analysis = new HttpClient(analysisHandler);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["CONTENT_UNDERSTANDING_ENDPOINT"] = "https://analysis.example/",
            ["CONTENT_UNDERSTANDING_API_KEY"] = "test-key"
        }).Build();
        var worker = new ContentUnderstandingSnapshotWorker(Blobs(storage), new("results"), config,
            new Factory(analysis), NullLogger<ContentUnderstandingSnapshotWorker>.Instance);
        await worker.SweepAsync(CancellationToken.None);
        Assert.Equal(deleted ? 1 : 0, handler.Deletes);
        Assert.Equal(deleted, handler.Journal!.Source is null);
        Assert.Equal(0, analysisHandler.Posts);
        Assert.Equal(1, analysisHandler.Polls);
    }

    [Fact]
    public async Task ActivityCleansTerminalSnapshotEvenWhenPackageAdaptationFails()
    {
        using var handler = new StorageHandler();
        using var storage = new HttpClient(handler);
        using var analysisHandler = new AnalysisHandler();
        using var analysis = new HttpClient(analysisHandler);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["INTEGRITY_VIDEO_PROVIDER"] = ExtractionPolicy.CuProvider,
            ["CONTENT_UNDERSTANDING_ENDPOINT"] = "https://analysis.example/",
            ["CONTENT_UNDERSTANDING_API_KEY"] = "test-key"
        }).Build();
        var activity = new ContentUnderstandingActivity(Blobs(storage), config, new Factory(analysis), new ExtractionPolicy(config), new("results"));
        // The synthetic succeeded response has no adapter provenance. Failure happens after terminal status was saved.
        await Assert.ThrowsAsync<InvalidDataException>(() => activity.RunAsync(Request, CancellationToken.None));
        Assert.Equal("succeeded", handler.Journal!.Phase);
        Assert.Null(handler.Journal.Source);
        Assert.Equal(1, handler.Creates);
        Assert.Equal(1, handler.Deletes);
        Assert.Equal(1, analysisHandler.Posts);
        await Assert.ThrowsAsync<InvalidDataException>(() => activity.RunAsync(Request, CancellationToken.None));
        Assert.Equal(1, handler.Creates);
        Assert.Equal(1, analysisHandler.Posts);
    }

    private sealed class MemoryStore : ICuOperationStore
    {
        public CuOperation? State;
        public bool RejectSnapshotSaveOnce;
        public Task<CuOperation?> ReadAsync(CancellationToken cancellationToken) => Task.FromResult(State);
        public Task SaveAsync(CuOperation operation, CancellationToken cancellationToken)
        {
            if (RejectSnapshotSaveOnce && operation.Source?.Snapshot is not null)
            { RejectSnapshotSaveOnce = false; throw new IOException("Simulated journal interruption"); }
            State = operation; return Task.CompletedTask;
        }
    }

    private sealed class AnalysisHandler : HttpMessageHandler
    {
        public HttpStatusCode PostStatus = HttpStatusCode.Accepted;
        public string OperationStatus = "succeeded";
        public int Posts, Polls;
        public Action<HttpRequestMessage>? BeforeRequest;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            BeforeRequest?.Invoke(request);
            cancellationToken.ThrowIfCancellationRequested();
            HttpResponseMessage response;
            if (request.Method == HttpMethod.Post)
            {
                Posts++;
                response = new(PostStatus);
                response.Headers.TryAddWithoutValidation("Operation-Location", OperationUrl);
            }
            else if (request.RequestUri!.AbsolutePath.Contains("analyzerResults"))
            {
                Polls++;
                response = new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new { status = OperationStatus, result = new { } })) };
            }
            else response = new(HttpStatusCode.OK) { Content = new StringContent("{\"config\":{\"returnDetails\":true}}") };
            response.Headers.TryAddWithoutValidation("Retry-After", "0");
            return Task.FromResult(response);
        }
    }

    private sealed class Factory(HttpClient client) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => client;
    }

    private sealed class StorageHandler : HttpMessageHandler
    {
        public readonly List<(string Snapshot, string Owner, string Path)> Snapshots = [];
        public CuOperation? Journal;
        public int Creates, Deletes, Reads;
        public bool FailDelete;
        public Action? BeforeCreate, BeforeDelete;
        private static readonly byte[] SourceBytes = "Synthetic source; no private content."u8.ToArray();
        private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            var query = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(uri.Query);
            query.TryGetValue("comp", out var component);
            HttpResponseMessage response = new(HttpStatusCode.OK);
            if (component == "list")
            {
                Reads++;
                string entries = uri.AbsolutePath == "/results" ?
                    "<Blob><Name>cu-operations/one.json</Name><Properties><Content-Length>100</Content-Length></Properties><Metadata><cuSnapshotPending>true</cuSnapshotPending></Metadata></Blob>" :
                    string.Concat(Snapshots.Select(snapshot => $"<Blob><Name>{snapshot.Path}</Name><Snapshot>{snapshot.Snapshot}</Snapshot><Properties><Content-Length>10</Content-Length></Properties><Metadata><cuSnapshotOwner>{snapshot.Owner}</cuSnapshotOwner></Metadata></Blob>"));
                response.Content = new StringContent($"<?xml version=\"1.0\" encoding=\"utf-8\"?><EnumerationResults ServiceEndpoint=\"https://storage.example/\" ContainerName=\"{uri.AbsolutePath.Trim('/')}\"><Blobs>{entries}</Blobs><NextMarker /></EnumerationResults>", Encoding.UTF8, "application/xml");
            }
            else if (component == "snapshot")
            {
                BeforeCreate?.Invoke();
                Assert.Equal("\"source-version\"", request.Headers.IfMatch.Single().Tag);
                Creates++;
                string snapshot = "2026-10-12T00:00:00.0000000Z";
                string owner = request.Headers.GetValues("x-ms-meta-cuSnapshotOwner").Single();
                Snapshots.Add((snapshot, owner, "raw-guid"));
                response.StatusCode = HttpStatusCode.Created;
                response.Headers.TryAddWithoutValidation("x-ms-snapshot", snapshot);
            }
            else if (request.Method == HttpMethod.Delete)
            {
                BeforeDelete?.Invoke();
                Assert.True(query.ContainsKey("snapshot")); // Never delete the original blob or all snapshots.
                Deletes++;
                response.StatusCode = FailDelete ? HttpStatusCode.InternalServerError : HttpStatusCode.Accepted;
                if (!FailDelete) Snapshots.RemoveAll(snapshot => snapshot.Snapshot == query["snapshot"] && "/input/" + snapshot.Path == uri.AbsolutePath);
            }
            else if (component == "lease")
            {
                response.StatusCode = request.Headers.GetValues("x-ms-lease-action").Single() == "acquire"
                    ? HttpStatusCode.Created : HttpStatusCode.OK;
                response.Headers.TryAddWithoutValidation("x-ms-lease-id", "lease-id");
            }
            else if (uri.AbsolutePath == "/input/raw-guid" && request.Method == HttpMethod.Head)
            {
                response.Content = new ByteArrayContent(SourceBytes);
                response.Headers.TryAddWithoutValidation("x-ms-blob-type", "BlockBlob");
                response.Content.Headers.LastModified = DateTimeOffset.Parse("2026-10-12T00:00:00Z");
            }
            else if (uri.AbsolutePath == "/input/raw-guid" && request.Method == HttpMethod.Get)
                response.Content = new ByteArrayContent(SourceBytes);
            else if (request.Method == HttpMethod.Post && query.ContainsKey("restype"))
            {
                // User-delegation SAS for the anonymous test Blob client.
                response.Content = new StringContent("""
                    <UserDelegationKey><SignedOid>00000000-0000-0000-0000-000000000000</SignedOid>
                    <SignedTid>00000000-0000-0000-0000-000000000000</SignedTid><SignedStart>2026-10-12T00:00:00Z</SignedStart>
                    <SignedExpiry>2026-10-13T00:00:00Z</SignedExpiry><SignedService>b</SignedService>
                    <SignedVersion>2025-11-05</SignedVersion><Value>dGVzdA==</Value></UserDelegationKey>
                    """, Encoding.UTF8, "application/xml");
            }
            else if (request.Method == HttpMethod.Get)
            {
                Reads++;
                response.Content = new StringContent(JsonSerializer.Serialize(Journal, JsonOptions), Encoding.UTF8, "application/json");
            }
            else if (request.Method == HttpMethod.Put)
            {
                if (!request.Headers.TryGetValues("x-ms-lease-id", out var leases))
                {
                    Assert.Equal("null", await request.Content!.ReadAsStringAsync(cancellationToken));
                    response.StatusCode = Journal is null ? HttpStatusCode.Created : HttpStatusCode.Conflict;
                }
                else
                {
                    Assert.Equal("lease-id", leases.Single());
                    Journal = JsonSerializer.Deserialize<CuOperation>(await request.Content!.ReadAsStringAsync(cancellationToken), JsonOptions);
                    Assert.Equal(Journal!.Source is null ? "false" : "true", request.Headers.GetValues("x-ms-meta-cuSnapshotPending").Single());
                    response.StatusCode = HttpStatusCode.Created;
                }
            }
            else throw new InvalidOperationException("Unexpected storage request");
            response.Headers.TryAddWithoutValidation("ETag", "\"source-version\"");
            response.Headers.TryAddWithoutValidation("Last-Modified", "Mon, 12 Oct 2026 00:00:00 GMT");
            return response;
        }
    }
}
