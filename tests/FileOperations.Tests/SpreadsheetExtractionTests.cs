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
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FileOperations.Tests;

public class SpreadsheetExtractionTests
{
    [Fact]
    public async Task PlainXlsxKeepsNativeWorksheetExtractionWithoutOcr()
    {
        using var source = new MemoryStream();
        SpreadsheetFixtures.Create(source, false);
        using var handler = new ExtractionHandler(source.ToArray());
        var result = await ExtractAsync(handler, new("input", "raw-guid", false, Filename: "records.xlsx"));
        Assert.False(result.RequiresFurtherAnalysis);
        Assert.Contains("## Sheet1", result.Content);
        Assert.Contains("## Sheet2", result.Content);
        Assert.Contains("00123", result.Content);
        Assert.Equal(0, handler.Analyses);
    }

    [Fact]
    public async Task RenderedWorkbookUsesPdfOcrDespiteKeepingOriginalXlsxFilename()
    {
        using var handler = new ExtractionHandler(Encoding.UTF8.GetBytes("%PDF-1.7\nSynthetic PDF transport fixture"));
        var result = await ExtractAsync(handler, new("input", "raw-guid", false, Filename: "photos.xlsx"));
        Assert.Equal("Photo OCR text", result.Content);
        Assert.Equal(1, handler.Analyses);
    }

    [Fact]
    public async Task LargeDocumentPreservesDocumentIntelligencePageBoundaries()
    {
        using var handler = new ExtractionHandler(Encoding.UTF8.GetBytes("%PDF-1.7\nSynthetic PDF transport fixture"), pageAware: true);
        var result = await ExtractAsync(handler, new("input", "raw-guid", false,
            Filename: "report.pdf", PreserveDocumentPages: true, ExpectedPageCount: 2));

        Assert.Equal("First page" + DocumentIntelligencePageMarkdown.PageBreak + "Second page", result.Content);
        Assert.Equal(1, handler.Analyses);
    }

    private static async Task<NeedAnalysis> ExtractAsync(ExtractionHandler handler, DocumentIntelligenceInput input)
    {
        using var http = new HttpClient(handler);
        var transport = new HttpClientTransport(http);
        var blobs = new BlobServiceClient(new Uri("https://storage.example/"), new BlobClientOptions { Transport = transport });
        var di = new DocumentIntelligenceClient(new Uri("https://analysis.example/"), new AzureKeyCredential("test"),
            new DocumentIntelligenceClientOptions { Transport = transport });
        using var telemetry = TelemetryConfiguration.CreateDefault();
        telemetry.DisableTelemetry = true;
        var activity = new DocumentIntelligenceResultActivity(NullLogger<DocumentIntelligenceResultActivity>.Instance,
            di, blobs, new TelemetryClient(telemetry));
        return await activity.RunAsync(input, CancellationToken.None);
    }

    private sealed class ExtractionHandler(byte[] source, bool pageAware = false) : HttpMessageHandler
    {
        public int Analyses { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            HttpResponseMessage response;
            if (request.RequestUri!.Host == "storage.example")
            {
                response = new(HttpStatusCode.OK) { Content = new ByteArrayContent(source) };
                response.Headers.TryAddWithoutValidation("ETag", "\"version\"");
                response.Headers.TryAddWithoutValidation("x-ms-blob-type", "BlockBlob");
                response.Content.Headers.LastModified = DateTimeOffset.Parse("2026-10-12T00:00:00Z");
                response.Content.Headers.ContentLength = source.Length;
            }
            else if (request.Method == HttpMethod.Post)
            {
                Analyses++;
                response = new(HttpStatusCode.Accepted);
                response.Headers.TryAddWithoutValidation("Operation-Location",
                    "https://analysis.example/documentintelligence/documentModels/prebuilt-layout/analyzeResults/one?api-version=2024-11-30");
                response.Headers.TryAddWithoutValidation("Retry-After", "0");
            }
            else
            {
                response = new(HttpStatusCode.OK) { Content = new StringContent(pageAware ? """
                    {"status":"succeeded","analyzeResult":{"apiVersion":"2024-11-30","modelId":"prebuilt-layout",
                     "stringIndexType":"utf16CodeUnit","content":"First pageSecond page","contentFormat":"markdown",
                     "pages":[{"pageNumber":1,"spans":[{"offset":0,"length":10}]},
                              {"pageNumber":2,"spans":[{"offset":10,"length":11}]}]}}
                    """ : """
                    {"status":"succeeded","analyzeResult":{"apiVersion":"2024-11-30","modelId":"prebuilt-layout",
                     "stringIndexType":"utf16CodeUnit","content":"Photo OCR text","contentFormat":"markdown","pages":[]}}
                    """, Encoding.UTF8, "application/json") };
            }
            return Task.FromResult(response);
        }
    }
}
