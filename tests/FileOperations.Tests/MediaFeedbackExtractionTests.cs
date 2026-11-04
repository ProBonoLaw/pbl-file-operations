using System.Net;
using System.Text.Json;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using Xunit;

namespace FileOperations.Tests;

public sealed class MediaFeedbackExtractionTests : IDisposable
{
    private const string CurrentAnalysis = "current-operation";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly string? previousEndpoint = Environment.GetEnvironmentVariable("DATA_INTEGRITY_SERVICE_URL");

    public MediaFeedbackExtractionTests() =>
        Environment.SetEnvironmentVariable("DATA_INTEGRITY_SERVICE_URL", "http://data-integrity-feedback-test");

    public void Dispose() => Environment.SetEnvironmentVariable("DATA_INTEGRITY_SERVICE_URL", previousEndpoint);

    [Theory]
    [InlineData("previous-source-operation")]
    [InlineData("previous-configuration-operation")]
    [InlineData("CURRENT-OPERATION")]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" ")]
    public async Task StaleFeedbackIsOmittedAndFreshRequestUsesCurrentAnalysis(string? oldAnalysis)
    {
        using var handler = new AdapterHandler();
        var input = Input();
        var stale = new MediaFeedback(true, Names(), Metadata(), oldAnalysis);

        var (response, feedbackExists) = await MediaFeedbackExtraction.ResolveAsync(
            Functions(handler), input, true, stale, CancellationToken.None);

        Assert.False(feedbackExists); // IngestionFlow creates fresh feedback with this input and result.
        Assert.Equal(CurrentAnalysis, IngestionFlow.ExtractionLocation(response).AnalysisId);
        Assert.Equal(CurrentAnalysis, input["speakerAnalysisId"]);
        Assert.False(input.ContainsKey("speakerNames"));
        Assert.False(input.ContainsKey("metadata"));
        var request = Assert.Single(handler.Requests);
        Assert.Equal("transform", request.Operation);
        Assert.False(request.Input.TryGetProperty("speakerNames", out _));
        Assert.False(request.Input.TryGetProperty("speakerAnalysisId", out _));
        Assert.Equal("Speaker 1", Assert.Single(handler.Packages).EvidenceLocations[0].Speaker);
    }

    [Fact]
    public async Task MatchingNamesAreAppliedOnlyAfterCurrentAnalysisIsResolved()
    {
        using var handler = new AdapterHandler();
        var input = Input();

        var (response, feedbackExists) = await MediaFeedbackExtraction.ResolveAsync(
            Functions(handler), input, true, new(true, Names(), Metadata(), CurrentAnalysis), CancellationToken.None);

        Assert.True(feedbackExists);
        Assert.Equal(CurrentAnalysis, IngestionFlow.ExtractionLocation(response).AnalysisId);
        Assert.Equal(new[] { "transform", "lookup", "transform" }, handler.Requests.Select(r => r.Operation));
        Assert.False(handler.Requests[0].Input.TryGetProperty("speakerNames", out _));
        Assert.False(handler.Requests[0].Input.TryGetProperty("metadata", out _));
        Assert.Equal(CurrentAnalysis, handler.Requests[2].Input.GetProperty("speakerAnalysisId").GetString());
        Assert.Equal("Jane", handler.Requests[2].Input.GetProperty("speakerNames").GetProperty("Speaker 1").GetString());
        Assert.Equal("Jane (Speaker 1)", handler.Packages.Last().EvidenceLocations[0].Speaker);
        Assert.Equal("Court", handler.Packages.Last().SourceMetadata!.Location);
    }

    [Fact]
    public async Task MatchingNamedCacheCanBeReusedAfterCurrentAnalysisIsResolved()
    {
        using var handler = new AdapterHandler(namedCacheHit: true);
        var input = Input();

        var (response, feedbackExists) = await MediaFeedbackExtraction.ResolveAsync(
            Functions(handler), input, true, new(true, Names(), null, CurrentAnalysis), CancellationToken.None);

        Assert.True(feedbackExists);
        Assert.Equal(CurrentAnalysis, IngestionFlow.ExtractionLocation(response).AnalysisId);
        Assert.Equal(new[] { "transform", "lookup" }, handler.Requests.Select(r => r.Operation));
        Assert.Equal("Jane (Speaker 1)", handler.Packages.Last().EvidenceLocations[0].Speaker);
    }

    [Fact]
    public async Task PendingFeedbackForCurrentAnalysisDoesNotCreateAnotherRequest()
    {
        using var handler = new AdapterHandler();

        var (_, feedbackExists) = await MediaFeedbackExtraction.ResolveAsync(
            Functions(handler), Input(), true, new(true, null, null, CurrentAnalysis), CancellationToken.None);

        Assert.True(feedbackExists);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task MissingFeedbackCreatesRequestForResolvedAnalysis()
    {
        using var handler = new AdapterHandler();
        var input = Input();

        var (_, feedbackExists) = await MediaFeedbackExtraction.ResolveAsync(
            Functions(handler), input, true, new(false, null, null, null), CancellationToken.None);

        Assert.False(feedbackExists);
        Assert.Equal(CurrentAnalysis, input["speakerAnalysisId"]);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task MatchingMetadataWithoutNamesIsAppliedToSameAnalysis()
    {
        using var handler = new AdapterHandler();

        var (_, feedbackExists) = await MediaFeedbackExtraction.ResolveAsync(
            Functions(handler), Input(), true, new(true, null, Metadata(), CurrentAnalysis), CancellationToken.None);

        Assert.True(feedbackExists);
        Assert.Equal("Court", handler.Packages.Last().SourceMetadata!.Location);
        Assert.Equal("Speaker 1", handler.Packages.Last().EvidenceLocations[0].Speaker);
    }

    [Fact]
    public async Task ForceStillResolvesCurrentOperationBeforeReusingFeedback()
    {
        using var handler = new AdapterHandler();
        var input = Input();
        input["force"] = true;

        var (_, feedbackExists) = await MediaFeedbackExtraction.ResolveAsync(
            Functions(handler), input, true, new(true, Names(), null, "old-operation"), CancellationToken.None);

        Assert.False(feedbackExists);
        Assert.True(Assert.Single(handler.Requests).Input.GetProperty("force").GetBoolean());
        Assert.Equal(CurrentAnalysis, input["speakerAnalysisId"]);
    }

    [Fact]
    public async Task ExistingNamesCannotEnterInitialCuResolution()
    {
        using var handler = new AdapterHandler();
        var input = Input();
        input["speakerNames"] = Names();
        input["speakerAnalysisId"] = "old-operation";

        await MediaFeedbackExtraction.ResolveAsync(
            Functions(handler), input, true, new(true, Names(), null, "old-operation"), CancellationToken.None);

        Assert.False(Assert.Single(handler.Requests).Input.TryGetProperty("speakerNames", out _));
        Assert.Equal(CurrentAnalysis, input["speakerAnalysisId"]);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"analysisId\":\"current-operation\"}")]
    [InlineData("{\"extractionContainerPath\":\"source.extraction.json\"}")]
    public async Task CannotReuseFeedbackWithoutCurrentPackageIdentity(string result)
    {
        using var handler = new AdapterHandler(initialResponse: result);

        await Assert.ThrowsAsync<InvalidDataException>(() => MediaFeedbackExtraction.ResolveAsync(
            Functions(handler), Input(), true, new(true, Names(), null, CurrentAnalysis), CancellationToken.None));

        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task NamedCacheFromAnotherAnalysisCannotBePublished()
    {
        using var handler = new AdapterHandler(namedCacheHit: true, namedAnalysis: "another-operation");

        await Assert.ThrowsAsync<InvalidDataException>(() => MediaFeedbackExtraction.ResolveAsync(
            Functions(handler), Input(), true, new(true, Names(), null, CurrentAnalysis), CancellationToken.None));
    }

    [Fact]
    public async Task LegacyMediaRetainsNamesAndCacheLookupBehavior()
    {
        using var handler = new AdapterHandler(legacy: true);
        var input = Input();

        var (response, feedbackExists) = await MediaFeedbackExtraction.ResolveAsync(
            Functions(handler), input, false, new(true, Names(), Metadata(), null), CancellationToken.None);

        Assert.True(feedbackExists);
        Assert.Null(IngestionFlow.ExtractionLocation(response).AnalysisId);
        Assert.Equal(new[] { "lookup", "transform" }, handler.Requests.Select(r => r.Operation));
        Assert.Equal("Jane", handler.Requests[0].Input.GetProperty("speakerNames").GetProperty("Speaker 1").GetString());
        Assert.Equal("Court", handler.Requests[0].Input.GetProperty("metadata").Deserialize<ResultMetadata>(JsonOptions)!.Location);
    }

    private static Dictionary<string, object?> Input() => new()
    {
        ["filename"] = "recording.wav", ["filePath"] = "folder/recording.wav",
        ["sourceId"] = "source", ["accountId"] = "account",
        ["containerName"] = "input", ["containerPath"] = "current-source"
    };

    private static Dictionary<string, string> Names() => new() { ["Speaker 1"] = "Jane" };
    private static ResultMetadata Metadata() => new(null, "Court", "Recording");
    private static HttpFunctions Functions(HttpMessageHandler handler) => new(new HttpClient(handler));
    private static JsonElement Json(string json) { using var document = JsonDocument.Parse(json); return document.RootElement.Clone(); }

    private sealed class AdapterHandler(bool namedCacheHit = false, bool legacy = false,
        string? initialResponse = null, string? namedAnalysis = null) : HttpMessageHandler
    {
        public List<(string Operation, JsonElement Input)> Requests { get; } = [];
        public List<ExtractionPackage> Packages { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            var operation = request.RequestUri!.Segments.Last();
            var input = Json(await request.Content!.ReadAsStringAsync(cancellationToken));
            Requests.Add((operation, input));
            if (operation == "lookup" && !namedCacheHit) return new(HttpStatusCode.NotFound);
            if (Requests.Count == 1 && initialResponse is not null) return Response(initialResponse);
            if (legacy) return Response("""{"containerName":"results","containerPath":"legacy.md"}""");

            var documentRequest = input.Deserialize<DocumentRequest>(JsonOptions)!;
            var raw = Json("""
                {"status":"Succeeded","result":{"analyzerId":"test","apiVersion":"2025-11-01","stringEncoding":"utf16","contents":[{
                  "startTimeMs":0,"endTimeMs":8000,
                  "transcriptPhrases":[{"speaker":"Speaker 1","startTimeMs":1000,"endTimeMs":2500,"text":"I saw the car."}]
                }]}}
                """);
            // Real adapter validation ensures stale names would fail if they reached transformation.
            Packages.Add(ContentUnderstandingAdapter.Convert(raw, documentRequest, "audio", "test", CurrentAnalysis,
                new string('a', 64), new string('b', 64)));
            return Response(JsonSerializer.Serialize(new
            {
                containerName = "results", containerPath = "current.md",
                extractionContainerPath = "current.extraction.json",
                analysisId = operation == "lookup" ? namedAnalysis ?? CurrentAnalysis : CurrentAnalysis
            }));
        }

        private static HttpResponseMessage Response(string json) => new(HttpStatusCode.OK)
        {
            Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json")
        };
    }
}
