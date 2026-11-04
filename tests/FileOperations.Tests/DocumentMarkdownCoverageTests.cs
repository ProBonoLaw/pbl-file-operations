using System.Text.Json;
using System.Text.Json.Nodes;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using Xunit;

namespace FileOperations.Tests;

public class DocumentMarkdownCoverageTests
{
    [Theory]
    [InlineData("Missing introduction\nKept text", "Kept text")]
    [InlineData("Kept text\nMissing conclusion", "Kept text")]
    [InlineData("Kept text\nMissing middle\nRetained ending", "Kept text", "Retained ending")]
    [InlineData("Kept 😀 text\nMissing 😀 text", "Kept 😀 text")]
    [InlineData("Kept text\n☒", "Kept text")]
    [InlineData("Kept text\n<!-- PageHeader=\"Missing header\" -->", "Kept text")]
    [InlineData("Kept text\n<!-- Unknown metadata -->", "Kept text")]
    public void RejectsAnyUncoveredLiteralRegion(string markdown, params string[] paragraphs)
    {
        var content = Content(markdown, paragraphs);
        var error = Assert.Throws<InvalidDataException>(() => Adapt(content));
        Assert.Contains("uncovered Markdown at UTF-16 offset", error.Message);
        Assert.DoesNotContain("Missing", error.Message); // Do not expose source text in failure logs.
    }

    [Fact]
    public void AllowsPageBreaksPageNumbersHeadingMarkersAndWhitespace()
    {
        const string markdown = "# First 😀 title\n\n<!-- PageNumber=\"1\" -->\n<!-- PageBreak -->\n\n## Second title\n";
        var package = Adapt(Content(markdown, "First 😀 title", "Second title"));
        Assert.Equal("First 😀 title\n\nSecond title", package.LiteralMarkdown);
        Assert.Equal(1, package.MarkdownCoverageVersion);
    }

    [Theory]
    [InlineData("<!-- PageHeader: Literal 😀 header -->")]
    [InlineData("<!-- PageFooter: Literal 😀 header -->")]
    [InlineData("<!-- PageHeader=\"Literal 😀 header\" -->")]
    [InlineData("<!-- PageFooter=\"Literal 😀 header\" -->")]
    public void PreservesCoveredHeaderFooterTextAndQuotationLocations(string wrapper)
    {
        var package = Adapt(Content(wrapper + "\nBody text", "Literal 😀 header", "Body text"));
        Assert.Equal("Literal 😀 header\n\nBody text", package.LiteralMarkdown);
        Assert.Equal(2, package.EvidenceLocations.Count);
        Assert.All(package.EvidenceLocations, location => Assert.Equal([1], location.Pages));
    }

    [Theory]
    [InlineData("<!-- PageHeader: Missing header -->")]
    [InlineData("<!-- PageFooter: Missing footer -->")]
    [InlineData("<!-- PageFooter=\"Missing footer\" -->")]
    [InlineData("<!-- PageHeader: Missing header")]
    [InlineData("<!-- Unknown: Missing text -->")]
    public void HeaderFooterWrappersDoNotConcealMissingOrMalformedText(string wrapper)
    {
        var content = Content("Body text\n" + wrapper, "Body text");
        var error = Assert.Throws<InvalidDataException>(() => Adapt(content));
        Assert.Contains("uncovered Markdown", error.Message);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void HeaderFigureRequiresIndependentLiteralAltTextCoverage(bool hasOcr)
    {
        const string image = "![Literal logo text](figures/1.1 \"Generated description\")";
        const string wrapper = "<!-- PageHeader: " + image + " -->\nBody text";
        var content = hasOcr ? Content(wrapper, "Literal logo text", "Body text") : Content(wrapper, "Body text");
        AddFigure(content, wrapper.IndexOf(image, StringComparison.Ordinal), image.Length);
        if (!hasOcr)
        {
            Assert.Throws<InvalidDataException>(() => Adapt(content));
            return;
        }
        var package = Adapt(content);
        Assert.Equal("Literal logo text\n\nBody text", package.LiteralMarkdown);
        Assert.DoesNotContain("Generated description", package.LiteralMarkdown);
        Assert.Contains(package.Blocks, block => block.Kind == "figure-description" && block.Origin == "generated");
        Assert.Equal("figures/1.1", Assert.Single(ContentUnderstandingAssets.Discover(package)).ServiceFilePath);
    }

    [Fact]
    public void RecoversMissingParagraphThroughLiteralOcrWords()
    {
        const string markdown = "Kept text\nRecovered 😀 text";
        var content = Content(markdown, "Kept text");
        content["pages"]![0]!["words"] = new JsonArray(Element("Recovered 😀 text", markdown.IndexOf("Recovered", StringComparison.Ordinal)));
        var package = Adapt(content);
        Assert.Contains("Recovered 😀 text", package.LiteralMarkdown);
        Assert.Contains(package.Blocks, block => block.Kind == "ocr" && block.Origin == "extracted");
    }

    [Fact]
    public void LiteralFormulaAndBarcodeSpansCoverTheirMarkdownRepresentations()
    {
        const string formula = "$x^2$", barcode = "![QRCode](barcodes/1.2 \"12345\")";
        string markdown = "Kept text\n" + formula + "\n" + barcode;
        var content = Content(markdown, "Kept text");
        content["pages"]![0]!["formulas"] = new JsonArray(new JsonObject
            { ["value"] = "x^2", ["span"] = Span(markdown.IndexOf(formula, StringComparison.Ordinal), formula.Length) });
        content["pages"]![0]!["barcodes"] = new JsonArray(new JsonObject
            { ["value"] = "12345", ["span"] = Span(markdown.IndexOf(barcode, StringComparison.Ordinal), barcode.Length) });
        var package = Adapt(content);
        Assert.Contains("x^2", package.LiteralMarkdown);
        Assert.Contains("12345", package.LiteralMarkdown);
    }

    [Fact]
    public void TableMarkupIsCoveredButSurroundingMissingTextIsRejected()
    {
        const string table = "<table><tr><td>Literal cell</td></tr></table>";
        var content = Content("Kept text\n" + table, "Kept text");
        content["tables"] = new JsonArray(new JsonObject
        {
            ["span"] = Span(10, table.Length),
            ["cells"] = new JsonArray(new JsonObject { ["rowIndex"] = 0, ["columnIndex"] = 0, ["content"] = "Literal cell" })
        });
        Assert.Contains("Literal cell", Adapt(content).LiteralMarkdown);
        content["markdown"] = content["markdown"]!.GetValue<string>() + "\nMissing footer";
        content["pages"]![0]!["spans"]![0]!["length"] = content["markdown"]!.GetValue<string>().Length;
        Assert.Throws<InvalidDataException>(() => Adapt(content));
    }

    [Theory]
    [InlineData("![ ](figures/1.1 \"Generated description\")", true)]
    [InlineData("![Uncovered photo OCR](figures/1.1 \"Generated description\")", false)]
    public void FigureSpanDoesNotConcealMissingLiteralAltText(string image, bool succeeds)
    {
        var content = Content("Kept text\n" + image, "Kept text");
        AddFigure(content, 10, image.Length);
        if (succeeds)
        {
            var package = Adapt(content);
            Assert.Equal("Kept text", package.LiteralMarkdown);
            Assert.Contains(package.Blocks, block => block.Origin == "generated" && block.Text.Contains("Generated description"));
        }
        else Assert.Throws<InvalidDataException>(() => Adapt(content));
    }

    [Fact]
    public void CoveredFigureOcrAndGeneratedChartHaveSeparateOrigins()
    {
        const string image = "![Literal photo OCR](figures/1.1 \"Generated description\")";
        const string chart = "\n\n```chart\n{\"type\":\"bar\"}\n```";
        var content = Content("Kept text\n" + image + chart, "Kept text", "Literal photo OCR");
        var figure = AddFigure(content, 10, image.Length + chart.Length);
        figure["content"] = new JsonObject { ["type"] = "bar" };
        var package = Adapt(content);
        Assert.Equal("Kept text\n\nLiteral photo OCR", package.LiteralMarkdown);
        Assert.DoesNotContain("Generated", package.LiteralMarkdown);
        Assert.DoesNotContain("bar", package.LiteralMarkdown);
        figure["content"]!["type"] = "line";
        Assert.Throws<InvalidDataException>(() => Adapt(content));
    }

    [Fact]
    public void FigureWithLeadingCaptionRetainsCaptionOcrAndGeneratedAnalysisSeparately()
    {
        const string caption = "Literal figure caption 😀";
        const string image = "![Literal photo OCR](figures/1.1 \"Generated description\")";
        const string chart = "\n\n```chart\n{\"type\":\"bar\"}\n```";
        string markdown = caption + "\n\n" + image + chart;
        var content = Content(markdown, caption, "Literal photo OCR");
        var figure = AddFigure(content, 0, markdown.Length);
        figure["content"] = new JsonObject { ["type"] = "bar" };
        var package = Adapt(content);
        Assert.Equal(caption + "\n\nLiteral photo OCR", package.LiteralMarkdown);
        Assert.Equal(2, package.EvidenceLocations.Count);
        Assert.Equal("figures/1.1", Assert.Single(ContentUnderstandingAssets.Discover(package)).ServiceFilePath);
        figure["content"]!["type"] = "line";
        Assert.Throws<InvalidDataException>(() => Adapt(content));
    }

    [Theory]
    [InlineData("Literal caption")]
    [InlineData("Literal photo OCR")]
    public void CaptionedFigureStillRequiresBothCaptionAndAltTextCoverage(string retainedText)
    {
        const string markdown = "Literal caption\n\n![Literal photo OCR](figures/1.1 \"Generated description\")";
        var content = Content(markdown, retainedText);
        AddFigure(content, 0, markdown.Length);
        Assert.Contains("uncovered Markdown", Assert.Throws<InvalidDataException>(() => Adapt(content)).Message);
    }

    [Fact]
    public void FigureCannotMaskAnotherImagesLinkSyntax()
    {
        const string markdown = "Literal caption\n\n![ ](figures/2.1 \"Generated description\")";
        var content = Content(markdown, "Literal caption");
        AddFigure(content, 0, markdown.Length);
        Assert.Throws<InvalidDataException>(() => Adapt(content));
    }

    [Fact]
    public void FigureSpanCannotCoverUnrelatedMissingTextAfterImage()
    {
        const string figure = "![ ](figures/1.1 \"Generated description\")\nMissing source";
        var content = Content("Kept text\n" + figure, "Kept text");
        AddFigure(content, 10, figure.Length);
        Assert.Throws<InvalidDataException>(() => Adapt(content));
    }

    [Fact]
    public void AnnotationSpanCannotConcealItsMissingSourceText()
    {
        const string markdown = "Kept text\nMissing annotated text";
        var content = Content(markdown, "Kept text");
        content["annotations"] = new JsonArray(new JsonObject
        {
            ["id"] = "one", ["spans"] = new JsonArray(Span(10, 22)),
            ["comments"] = new JsonArray(new JsonObject { ["author"] = "Reviewer", ["message"] = "A retained comment" })
        });
        Assert.Throws<InvalidDataException>(() => Adapt(content));
    }

    [Fact]
    public void ChecksEachDocumentContentIndependently()
    {
        var second = Content("Kept text\nMissing text", "Kept text");
        second["pages"]![0]!["pageNumber"] = 2;
        var response = JsonSerializer.SerializeToElement(new { status = "Succeeded", result = new
        {
            analyzerId = "test", apiVersion = "2025-11-01", stringEncoding = "utf16",
            contents = new[] { Content("Kept text", "Kept text"), second }
        } });
        var error = Assert.Throws<InvalidDataException>(() => ContentUnderstandingAdapter.Convert(response,
            new("source.pdf", "source.pdf", "source", "account"), "document", "test", "one", new string('a', 64), new string('b', 64)));
        Assert.Contains("content 1", error.Message);
    }

    private static JsonObject Content(string markdown, params string[] paragraphs) => new()
    {
        ["mimeType"] = "application/pdf", ["markdown"] = markdown,
        ["pages"] = new JsonArray(new JsonObject { ["pageNumber"] = 1, ["spans"] = new JsonArray(Span(0, markdown.Length)) }),
        ["paragraphs"] = new JsonArray(paragraphs.Select(text => (JsonNode)Element(text, markdown.IndexOf(text, StringComparison.Ordinal))).ToArray())
    };
    private static JsonObject Element(string text, int offset) => new() { ["content"] = text, ["span"] = Span(offset, text.Length) };
    private static JsonObject Span(int offset, int length) => new() { ["offset"] = offset, ["length"] = length };
    private static JsonObject AddFigure(JsonObject content, int offset, int length)
    {
        var figure = new JsonObject { ["id"] = "1.1", ["description"] = "Generated description", ["span"] = Span(offset, length) };
        content["figures"] = new JsonArray(figure);
        return figure;
    }
    private static ExtractionPackage Adapt(JsonObject content)
    {
        var response = JsonSerializer.SerializeToElement(new { status = "Succeeded", result = new
        {
            analyzerId = "test", apiVersion = "2025-11-01", stringEncoding = "utf16", contents = new[] { content }
        } });
        return ContentUnderstandingAdapter.Convert(response, new("source.pdf", "source.pdf", "source", "account"),
            "document", "test", "one", new string('a', 64), new string('b', 64));
    }
}
