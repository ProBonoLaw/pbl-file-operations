using System.Net;
using System.Text;
using System.Text.Json;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration.Helpers;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace FileOperations.Tests;

public class ContentUnderstandingTests
{
    private static readonly DocumentRequest Request = new("source.pdf", "source.pdf", "source", "account");
    private static JsonElement Json(string value) { using var json = JsonDocument.Parse(value); return json.RootElement.Clone(); }
    private static ExtractionPackage Adapt(JsonElement response, string media = "document", DocumentRequest? request = null) =>
        ContentUnderstandingAdapter.Convert(response, request ?? Request, media, "test", "operation-1", new string('a', 64), new string('b', 64));

    private static JsonElement DocumentResponse() => Json("""
        {"status":"Succeeded","result":{"analyzerId":"test","apiVersion":"2025-11-01","stringEncoding":"utf16","contents":[{
          "mimeType":"application/pdf","markdown":"😀Title\nLiteral text\n![ ](figures/1.1 \"Generated damage description\")",
          "pages":[{"pageNumber":1,"spans":[{"offset":0,"length":69}]}],
          "paragraphs":[{"content":"😀Title","role":"title","span":{"offset":0,"length":7},"source":"D(1,0,0,1,1)"},
                        {"content":"Literal text","span":{"offset":8,"length":12},"source":"D(1,0,1,1,1)"}],
          "figures":[{"id":"1.1","span":{"offset":21,"length":48},"source":"D(1,0,2,1,1)","description":"Generated damage description"}],
          "fields":{"Summary":{"valueString":"Generated summary"}}
        }]}}
        """);

    [Fact]
    public void GeneratedDescriptionsAndSummariesCannotBecomeLiteralQuotationSources()
    {
        var package = Adapt(DocumentResponse());
        Assert.Equal("😀Title\n\nLiteral text", package.LiteralMarkdown);
        Assert.DoesNotContain("Generated", package.LiteralMarkdown);
        Assert.Equal(2, package.EvidenceLocations.Count);
        Assert.All(package.EvidenceLocations, location => Assert.Equal("extracted", package.Blocks.Single(b => b.Id == location.BlockId).Origin));
        Assert.Contains(package.Blocks, b => b.Kind == "figure-description" && b.Origin == "generated");
        Assert.Equal(9, package.EvidenceLocations[1].Offset); // UTF-16 surrogate pair retained.
    }

    [Fact]
    public void RejectsWrongSpanEncodingAndMissingPhysicalDetails()
    {
        Assert.Throws<InvalidDataException>(() => Adapt(Json(DocumentResponse().GetRawText().Replace("utf16", "codePoint"))));
        Assert.Throws<InvalidDataException>(() => Adapt(Json(DocumentResponse().GetRawText().Replace("\"offset\":21", "\"offset\":2100"))));
    }

    [Fact]
    public void CrossPageTableKeepsLiteralMergedCellsAndAllSourcePages()
    {
        var response = Json("""
            {"status":"Succeeded","result":{"analyzerId":"test","apiVersion":"2025-11-01","stringEncoding":"utf16","contents":[{
              "mimeType":"application/pdf","markdown":"01234567890123456789",
              "pages":[{"pageNumber":1,"spans":[{"offset":0,"length":10}]},{"pageNumber":2,"spans":[{"offset":10,"length":10}]}],
              "tables":[{"span":{"offset":0,"length":20},"cells":[
                {"rowIndex":0,"columnIndex":0,"columnSpan":2,"kind":"columnHeader","content":"Literal header","source":"D(1,0,0,1,1)"},
                {"rowIndex":1,"columnIndex":0,"content":"Literal cell & value","source":"D(2,0,0,1,1)"}]}],
              "paragraphs":[{"span":{"offset":0,"length":5},"content":"Duplicated cell"}]
            }]}}
            """);
        var package = Adapt(response);
        var table = Assert.Single(package.Blocks);
        Assert.Equal(new[] { 1, 2 }, table.Pages);
        Assert.Contains("colspan=\"2\"", table.Text);
        Assert.Contains("Literal cell &amp; value", table.Text);
        Assert.DoesNotContain("Duplicated", package.LiteralMarkdown);
        Assert.Equal(2, Assert.Single(package.EvidenceLocations).Regions.Count);
    }

    private static JsonElement AudioResponse() => Json("""
        {"status":"Succeeded","result":{"analyzerId":"test","apiVersion":"2025-11-01","stringEncoding":"utf16","contents":[{
          "kind":"audioVisual","startTimeMs":0,"endTimeMs":8000,"markdown":"WEBVTT",
          "transcriptPhrases":[{"speaker":"Speaker 1","startTimeMs":1000,"endTimeMs":2500,"text":"I saw the car."},
                               {"speaker":"Speaker 2","startTimeMs":3000,"endTimeMs":6000,"text":"Which car?"}],
          "fields":{"Summary":{"valueString":"Generated conversation summary"}}
        }]}}
        """);

    [Fact]
    public void AudioPreservesPhraseTimingAndSeparatesGeneratedSummary()
    {
        var package = Adapt(AudioResponse(), "audio");
        Assert.Equal("I saw the car.\n\nWhich car?", package.LiteralMarkdown);
        Assert.All(package.EvidenceLocations, location => Assert.Empty(location.Pages));
        Assert.Equal(1000, package.EvidenceLocations[0].StartTimeMs);
        Assert.Equal("Speaker 2", package.EvidenceLocations[1].Speaker);
        Assert.Throws<ArgumentException>(() => Adapt(AudioResponse(), "audio", Request with
            { SpeakerNames = new() { ["Speaker 1"] = "Jane" }, SpeakerAnalysisId = "old-analysis" }));
        var named = Adapt(AudioResponse(), "audio", Request with
            { SpeakerNames = new() { ["Speaker 1"] = "Jane" }, SpeakerAnalysisId = "operation-1" });
        Assert.Equal("Jane (Speaker 1)", named.EvidenceLocations[0].Speaker);
    }

    [Fact]
    public void VideoKeepsWholeBoundaryPhrasesOnceAndAcceptsSilentSegments()
    {
        var response = Json("""
            {"status":"Succeeded","result":{"analyzerId":"test","apiVersion":"2025-11-01","stringEncoding":"utf16","contents":[
              {"startTimeMs":0,"endTimeMs":5000,"transcriptPhrases":[{"startTimeMs":4000,"endTimeMs":7000,"text":"A complete phrase.","speaker":"Speaker 1"}],"keyFrameTimesMs":[0]},
              {"startTimeMs":5000,"endTimeMs":10000,"transcriptPhrases":[{"startTimeMs":4000,"endTimeMs":7000,"text":"A complete phrase.","speaker":"Speaker 1"}]},
              {"startTimeMs":10000,"endTimeMs":11000,"KeyFrameTimesMs":[10000]}]}}
            """);
        var package = Adapt(response, "video");
        Assert.Equal("A complete phrase.", package.LiteralMarkdown);
        var location = Assert.Single(package.EvidenceLocations);
        Assert.Equal(4000, location.StartTimeMs);
        Assert.Equal(7000, location.EndTimeMs);
        Assert.Equal(2, package.Blocks.Count(b => b.Kind == "keyframes"));
    }

    [Fact]
    public void CacheSeparatesProviderSettingsAndOfficeRenditions()
    {
        Assert.NotEqual(NameHelper.GenerateTempFileName(Request), NameHelper.GenerateTempFileName(Request, "cu-v1"));
        Assert.NotEqual(NameHelper.GenerateTempFileName(Request, "cu-v1"), NameHelper.GenerateTempFileName(Request, "cu-v2"));
        var rendered = Request with { Rendition = new("source.docx", "original", "pdf", "renderer", "version") };
        Assert.NotEqual(NameHelper.GenerateTempFileName(Request), NameHelper.GenerateTempFileName(rendered));
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> {
            ["INTEGRITY_DOCUMENT_PROVIDER"] = "content-understanding", ["CONTENT_UNDERSTANDING_ENDPOINT"] = "https://example.services.ai.azure.com/"
        }).Build();
        var policy = new ExtractionPolicy(configuration);
        Assert.Equal("content-understanding", policy.Provider(Request));
        Assert.Equal("document-intelligence", policy.Provider(Request with { HighRes = true }));
    }

    [Fact]
    public async Task ResumesSavedOperationWithoutAnotherAnalyzePost()
    {
        var store = new MemoryOperationStore(new("polling", "https://example.services.ai.azure.com/contentunderstanding/analyzerResults/one?api-version=2025-11-01"));
        var handler = new Handler(_ => new(HttpStatusCode.OK) { Content = new StringContent("{\"status\":\"Succeeded\",\"result\":{}}") });
        var client = Client(handler);
        var privateInput = new ContentUnderstandingInput(5, "input", "text/plain",
            _ => throw new Exception("A resumed operation must not reopen its input"));
        await client.AnalyzeAsync("test", "", store, CancellationToken.None, privateInput);
        Assert.Single(handler.Methods);
        Assert.Equal(HttpMethod.Get, handler.Methods[0]);
        Assert.Equal("succeeded", store.Operation!.Phase);
        await client.AnalyzeAsync("test", "https://storage/source?secret", store, CancellationToken.None);
        Assert.Single(handler.Methods);
    }

    [Fact]
    public async Task RejectsForeignOperationAndUnknownSubmissionWithoutSendingCredentials()
    {
        var handler = new Handler(_ => throw new Exception("Must not call HTTP"));
        var client = Client(handler);
        Assert.Throws<InvalidDataException>(() => client.ValidateOperation("https://other.example/contentunderstanding/analyzerResults/one"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => client.AnalyzeAsync("test", "https://storage/source",
            new MemoryOperationStore(new("submitting")), CancellationToken.None));
        Assert.Empty(handler.Methods);
    }

    [Fact]
    public async Task DefiniteSubmissionFailureIsSavedAndDoesNotResubmit()
    {
        var handler = new Handler(request => request.Method == HttpMethod.Get
            ? new(HttpStatusCode.OK) { Content = new StringContent("{\"config\":{\"returnDetails\":true}}") }
            : new(HttpStatusCode.TooManyRequests) { Content = new StringContent("{}") });
        var store = new MemoryOperationStore(null);
        var client = Client(handler);
        await Assert.ThrowsAsync<HttpRequestException>(() => client.AnalyzeAsync("test", "https://storage/source", store, CancellationToken.None));
        Assert.Equal("failed", store.Operation!.Phase);
        await Assert.ThrowsAsync<InvalidOperationException>(() => client.AnalyzeAsync("test", "https://storage/source", store, CancellationToken.None));
        Assert.Single(handler.Methods, method => method == HttpMethod.Post);
    }

    [Fact]
    public async Task RetrievesRasterAssetsOnlyFromTheConfiguredOperation()
    {
        byte[] jpeg = [0xff, 0xd8, 0xff, 0xd9];
        string? uri = null;
        var handler = new Handler(request =>
        {
            uri = request.RequestUri!.AbsoluteUri;
            return new(HttpStatusCode.OK) { Content = new ByteArrayContent(jpeg) };
        });
        var client = Client(handler);
        var result = await client.GetImageAsync("https://example.services.ai.azure.com/contentunderstanding/analyzerResults/one?api-version=2025-11-01",
            "figures/1.1", CancellationToken.None);
        Assert.Equal(jpeg, result.Bytes);
        Assert.Equal("image/jpeg", result.ContentType);
        Assert.Equal("https://example.services.ai.azure.com/contentunderstanding/analyzerResults/one/files/figures/1.1?api-version=2025-11-01", uri);
        await Assert.ThrowsAsync<InvalidDataException>(() => client.GetImageAsync(
            "https://example.services.ai.azure.com/contentunderstanding/analyzerResults/one", "../secrets", CancellationToken.None));
        await Assert.ThrowsAsync<InvalidDataException>(() => client.GetImageAsync(
            "https://example.services.ai.azure.com/contentunderstanding/analyzerResults/one", "figures/..", CancellationToken.None));
        await Assert.ThrowsAsync<InvalidDataException>(() => client.GetImageAsync(
            "https://foreign.example/contentunderstanding/analyzerResults/one", "figures/1.1", CancellationToken.None));
        Assert.Single(handler.Methods);
    }

    [Fact]
    public void LinksRetainedImagesToGeneratedMarkdownWithoutChangingLiteralText()
    {
        var package = Adapt(DocumentResponse());
        var reference = Assert.Single(ContentUnderstandingAssets.Discover(package));
        Assert.Equal("figures/1.1", reference.ServiceFilePath);
        Assert.Contains("0:figure-description:21", reference.BlockIds);
        var asset = new ExtractionAsset(reference.Id, reference.Kind, "results", "cu-assets/photo.jpg", "image/jpeg",
            new string('c', 64), 123, reference.ServiceFilePath, reference.BlockIds, reference.Pages, reference.Regions,
            "https://storage.blob.core.windows.net/results/cu-assets/photo.jpg");
        var retained = package with { Assets = [asset] };
        Assert.Contains("![figure](https://storage.blob.core.windows.net/results/cu-assets/photo.jpg)", ContentUnderstandingAssets.Markdown(retained, "source.pdf"));
        Assert.DoesNotContain("photo.jpg", retained.LiteralMarkdown);
    }

    private static ContentUnderstandingClient Client(Handler handler) => new(new HttpClient(handler),
        new(new("https://example.services.ai.azure.com/"), "test-key", "test", "test", "test", "geography", "1", null, TimeSpan.FromSeconds(5)));
    private sealed class MemoryOperationStore(CuOperation? operation) : ICuOperationStore
    {
        public CuOperation? Operation = operation;
        public Task<CuOperation?> ReadAsync(CancellationToken cancellationToken) => Task.FromResult(Operation);
        public Task SaveAsync(CuOperation value, CancellationToken cancellationToken) { Operation = value; return Task.CompletedTask; }
    }
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public List<HttpMethod> Methods { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        { Methods.Add(request.Method); return Task.FromResult(respond(request)); }
    }
}
