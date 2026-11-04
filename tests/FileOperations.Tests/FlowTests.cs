using System.Text.Json;
using System.Net;
using System.Text;
using FileOperations;
using Xunit;

namespace FileOperations.Tests;

public class FlowTests
{
    [Fact]
    public void StopMarkerMatchesEvidenceTaskWorkerIdentity()
    {
        var jobId = "v2-" + new string('A', 64) + ":372:94489284432";
        Assert.Equal("stopped-jobs/d917fad80e0cc0f5c6ba1d5418dc8faa1e356655bb3d1dbd03646b1d760f87fa.json",
            IngestionStopStore.MarkerPath("account", "391", jobId));
    }

    [Theory]
    [InlineData("Shared%2520Documents%252FFolder%252Fcontract.pdf", "Folder/contract.pdf")]
    [InlineData("%252fShared%2bDocuments%252fFolder%252fcontract.pdf", "Folder/contract.pdf")]
    [InlineData("https://example.sharepoint.com/sites/account/Shared%20Documents/Folder/contract.pdf",
        "Folder/contract.pdf")]
    public void DecodesSharePointConnectorIdentifier(string identifier, string expected)
    {
        Assert.Equal(expected, SharePointGraph.DecodeConnectorPath(identifier));
    }

    [Fact]
    public void ReadsNestedConversionLocation()
    {
        using var response = JsonDocument.Parse(
            """{"output":{"ContainerName":"results","ContainerPath":"converted.md"}}""");
        Assert.Equal(("results", "converted.md"), IngestionFlow.Location(response.RootElement));
    }

    [Fact]
    public void ReadsCaseInsensitiveConversionLocation()
    {
        using var response = JsonDocument.Parse(
            """{"OUTPUT":{"containername":"results","containerpath":"converted.md"}}""");
        Assert.Equal(("results", "converted.md"), IngestionFlow.Location(response.RootElement));
    }

    [Fact]
    public void ReadsExtractionPackageHandoffAndRejectsMissingAnalysisIdentity()
    {
        using var valid = JsonDocument.Parse("""{"output":{"ExtractionContainerPath":"converted.extraction.json","AnalysisId":"analysis-1"}}""");
        Assert.Equal(("converted.extraction.json", "analysis-1"), IngestionFlow.ExtractionLocation(valid.RootElement));
        using var invalid = JsonDocument.Parse("""{"extractionContainerPath":"converted.extraction.json"}""");
        Assert.Throws<InvalidDataException>(() => IngestionFlow.ExtractionLocation(invalid.RootElement));
    }

    [Fact]
    public void ProgressPartitionKeyIsSafeAndStableForSharePointUrls()
    {
        var identifier = "https://contoso.sharepoint.com/sites/account/Shared Documents/a#b?.pdf";

        var partitionKey = IngestionFlow.ProgressPartitionKey("account", identifier);

        Assert.Equal(partitionKey, IngestionFlow.ProgressPartitionKey("account", identifier));
        Assert.StartsWith("v2-", partitionKey);
        Assert.DoesNotContain("/", partitionKey);
        Assert.DoesNotContain("\\", partitionKey);
        Assert.DoesNotContain("#", partitionKey);
        Assert.DoesNotContain("?", partitionKey);
    }

    [Fact]
    public void RejectsIncompleteConversionLocation()
    {
        using var response = JsonDocument.Parse("""{"output":{"ContainerName":"results"}}""");
        Assert.Throws<InvalidDataException>(() => IngestionFlow.Location(response.RootElement));
    }

    [Fact]
    public void RejectsStringConversionOutput()
    {
        using var response = JsonDocument.Parse(
            """{"runtimeStatus":"Completed","output":"conversion failed"}""");
        var error = Assert.Throws<InvalidDataException>(() => IngestionFlow.Location(response.RootElement));
        Assert.Contains("conversion failed", error.Message);
    }

    [Fact]
    public async Task DeletionUsesInternalDataIngestionEndpointAndSourceBody()
    {
        Environment.SetEnvironmentVariable("DATA_INGESTION_SERVICE_URL", "http://data-ingestion-api");
        var handler = new RecordingHandler();
        var functions = new HttpFunctions(new HttpClient(handler));

        await functions.RemoveDocumentAsync(new
        {
            sourceId = "42", accountId = "account", isCurrentOrder = false,
            documentName = "not important"
        }, CancellationToken.None);

        Assert.Equal(HttpMethod.Delete, handler.Method);
        Assert.Equal("http://data-ingestion-api/internal/data-ingestion/remove", handler.Uri!.AbsoluteUri);
        using var body = JsonDocument.Parse(handler.Body!);
        Assert.Equal("42", body.RootElement.GetProperty("sourceId").GetString());
        Assert.False(body.RootElement.GetProperty("isCurrentOrder").GetBoolean());
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public HttpMethod? Method { get; private set; }
        public Uri? Uri { get; private set; }
        public string? Body { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Method = request.Method;
            Uri = request.RequestUri;
            Body = await request.Content!.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json")
            };
        }
    }
}
