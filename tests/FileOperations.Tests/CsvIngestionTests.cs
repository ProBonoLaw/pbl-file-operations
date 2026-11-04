using System.Net;
using System.Text;
using Azure;
using Azure.AI.DocumentIntelligence;
using Azure.Core.Pipeline;
using Azure.Storage.Blobs;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.Extensibility;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FileOperations.Tests;

public class CsvIngestionTests
{
    [Theory]
    [InlineData("https://example.test/data.CSV?download=1", true)]
    [InlineData("https://example.test/photos.xlsx", true)]
    [InlineData("https://example.test/data%2Ecsv", true)]
    [InlineData("https://example.test/page", false)]
    public void DownloadsWebsiteSpreadsheetsAsDocuments(string url, bool expected)
        => Assert.Equal(expected, WebsiteIngestionFlow.IsDocumentUri(new Uri(url)));

    [Fact]
    public void PreservesQuotedFieldsMultilineTextUnicodeAndTextValues()
    {
        const string csv = "\uFEFFId,Description,Value\r\n00123,\"A, B and \"\"quotes\"\"\",=1+1\r\n00234,\"first line\r\nsecond 😀 line\",2026-10-12\r\n00345,pipe|value,\r\n";
        using var source = new MemoryStream(Encoding.UTF8.GetBytes(csv));
        var markdown = CsvMarkdownConverter.Convert(source);
        Assert.Contains("| Id | Description | Value |", markdown);
        Assert.Contains("| 00123 | A, B and &quot;quotes&quot; | =1+1 |", markdown);
        Assert.Contains("first line<br/>second 😀 line", markdown);
        Assert.Contains("2026-10-12", markdown);
        Assert.Contains("pipe\\|value |  |", markdown);
        Assert.DoesNotContain('\uFEFF', markdown);
    }

    [Fact]
    public void HandlesHeaderlessRaggedRecordsAndEscapesMarkup()
    {
        using var source = new MemoryStream(Encoding.UTF8.GetBytes("001,<script>\n002,other,third\n"));
        var markdown = CsvMarkdownConverter.Convert(source);
        Assert.Contains("| Column 1 | Column 2 | Column 3 |", markdown);
        Assert.Contains("| 001 | &lt;script&gt; |  |", markdown);
        Assert.Contains("| 002 | other | third |", markdown);
    }

    [Fact]
    public void AcceptsBomMarkedUnicode()
    {
        using var source = new MemoryStream(Encoding.Unicode.GetPreamble().Concat(Encoding.Unicode.GetBytes("Id,Text\n001,漢字")).ToArray());
        Assert.Contains("漢字", CsvMarkdownConverter.Convert(source));
    }

    [Theory]
    [InlineData("")]
    [InlineData("a,\"unterminated\nb,c")]
    public void RejectsEmptyOrMalformedInput(string csv)
    {
        using var source = new MemoryStream(Encoding.UTF8.GetBytes(csv));
        Assert.Throws<InvalidDataException>(() => CsvMarkdownConverter.Convert(source));
    }

    [Fact]
    public void RejectsLimitViolationsInsteadOfSilentlyDiscardingData()
    {
        foreach (var csv in new[]
        {
            new string('x', CsvMarkdownConverter.MaxCellCharacters + 1),
            string.Join(',', Enumerable.Repeat("x", CsvMarkdownConverter.MaxColumns + 1)),
            string.Concat(Enumerable.Repeat("x\n", CsvMarkdownConverter.MaxRows + 1))
        })
        {
            using var source = new MemoryStream(Encoding.UTF8.GetBytes(csv));
            Assert.Throws<InvalidDataException>(() => CsvMarkdownConverter.Convert(source));
        }
    }

    [Fact]
    public async Task CsvUsesLocalExtractionWhenContentUnderstandingIsEnabled()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            { ["INTEGRITY_DOCUMENT_PROVIDER"] = ExtractionPolicy.CuProvider }).Build();
        var policy = new ExtractionPolicy(configuration);
        var request = new DocumentRequest("records.CSV", "records.CSV", "source", "account");
        Assert.Equal("document-intelligence", policy.Provider(request));
        Assert.Equal("document-intelligence", policy.Provider(request with { Filename = "", FilePath = "source.csv" }));
        Assert.Equal("", policy.CacheIdentity(request)); // No CU endpoint, model, or paid analysis is required.
        using var handler = new CsvBlobHandler();
        using var client = new HttpClient(handler);
        var transport = new HttpClientTransport(client);
        var blobs = new BlobServiceClient(new Uri("https://storage.example/"), new BlobClientOptions { Transport = transport });
        var di = new DocumentIntelligenceClient(new Uri("https://analysis.example/"), new AzureKeyCredential("test"),
            new DocumentIntelligenceClientOptions { Transport = transport });
        using var telemetry = TelemetryConfiguration.CreateDefault();
        telemetry.DisableTelemetry = true;
        var activity = new DocumentIntelligenceResultActivity(NullLogger<DocumentIntelligenceResultActivity>.Instance,
            di, blobs, new TelemetryClient(telemetry));
        var result = await activity.RunAsync(new("input", "raw-guid", false, Filename: "records.CSV"), CancellationToken.None);
        Assert.False(result.RequiresFurtherAnalysis);
        Assert.Contains("| 00123 | 42 |", result.Content);
        Assert.Equal(new[] { "HEAD", "GET" }, handler.Methods);
    }

    private sealed class CsvBlobHandler : HttpMessageHandler
    {
        public List<string> Methods { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.Equal("storage.example", request.RequestUri!.Host);
            Methods.Add(request.Method.Method);
            if (request.Method == HttpMethod.Get) Assert.Equal("\"csv-version\"", request.Headers.IfMatch.Single().Tag);
            byte[] bytes = Encoding.UTF8.GetBytes("Id,Amount\n00123,42\n");
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) };
            response.Headers.TryAddWithoutValidation("ETag", "\"csv-version\"");
            response.Headers.TryAddWithoutValidation("x-ms-blob-type", "BlockBlob");
            response.Headers.TryAddWithoutValidation("x-ms-request-id", "test");
            response.Content.Headers.LastModified = DateTimeOffset.Parse("2026-10-12T00:00:00Z");
            response.Content.Headers.ContentLength = bytes.Length;
            return Task.FromResult(response);
        }
    }
}
