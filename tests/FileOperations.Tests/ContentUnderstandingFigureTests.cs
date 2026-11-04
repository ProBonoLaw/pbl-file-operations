using System.Text.Json;
using System.Text.Json.Nodes;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using Xunit;

namespace FileOperations.Tests;

public class ContentUnderstandingFigureTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(4)] // Inside the preceding page: an empty span must not overlap it.
    [InlineData(8)] // At the page boundary, as in the failed CU response.
    [InlineData(16)]
    public void EmptyFigureSpanUsesExplicitPageAndRetainsImageWithoutChangingLiteralText(int offset)
    {
        var content = Content();
        content["figures"] = new JsonArray(Figure("2.1", offset));
        var package = Adapt(content);
        var figure = Assert.Single(package.Blocks, b => b.Kind == "figure-description");
        Assert.Equal([2], figure.Pages);
        Assert.Equal("generated", figure.Origin);
        Assert.Equal(0, Assert.Single(figure.ServiceSpans).Length);
        Assert.Equal("Page one<!-- PageBreak -->Page two", package.LiteralMarkdown);
        Assert.Equal(2, package.EvidenceLocations.Count);
        Assert.DoesNotContain(package.EvidenceLocations, l => l.BlockId == figure.Id);
        var reference = Assert.Single(ContentUnderstandingAssets.Discover(package));
        Assert.Equal([figure.Id], reference.BlockIds);
        Assert.Equal([2], reference.Pages);
        Assert.Equal(figure.Regions, reference.Regions);
        Assert.Equal("figures/2.1", reference.ServiceFilePath);
        var asset = new ExtractionAsset(reference.Id, reference.Kind, "results", "figure.jpg", "image/jpeg",
            new string('c', 64), 4, reference.ServiceFilePath, reference.BlockIds, reference.Pages,
            reference.Regions, "https://storage.example/results/figure.jpg");
        Assert.Contains("![figure](https://storage.example/results/figure.jpg)",
            ContentUnderstandingAssets.Markdown(package with { Assets = [asset] }, "source.pdf"));
    }

    [Fact]
    public void EmptyFiguresAtSameOffsetKeepDistinctBlocksAndAssetLinks()
    {
        var content = Content();
        var second = Figure("2.2", 8);
        second.Remove("description");
        content["figures"] = new JsonArray(Figure("2.1", 8), second);
        var package = Adapt(content);
        Assert.Equal(package.Blocks.Count, package.Blocks.Select(b => b.Id).Distinct().Count());
        var references = ContentUnderstandingAssets.Discover(package);
        Assert.Equal(2, references.Count);
        Assert.NotEqual(Assert.Single(references[0].BlockIds), Assert.Single(references[1].BlockIds));
        var artifact = Assert.Single(package.Blocks, b => b.Kind == "figure");
        Assert.Equal("artifact", artifact.Origin);
        Assert.Equal([artifact.Id], references[1].BlockIds);
    }

    [Fact]
    public void NonemptyFigureDoesNotCaptureAnEmptyFiguresAssetBinding()
    {
        var content = Content();
        var nonempty = Figure("1.1", 0);
        nonempty["span"]!["length"] = 8;
        nonempty["source"] = "D(1,0,0,1,0,1,1,0,1)";
        content["figures"] = new JsonArray(nonempty, Figure("2.1", 4));
        var references = ContentUnderstandingAssets.Discover(Adapt(content));
        Assert.Equal([1], references[0].Pages);
        Assert.Equal([2], references[1].Pages);
        Assert.DoesNotContain(Assert.Single(references[1].BlockIds), references[0].BlockIds);
    }

    [Fact]
    public void EmptyFigureOnBlankPageKeepsPageAndAssetProvenance()
    {
        var content = Content();
        content["markdown"] = "";
        content["paragraphs"] = new JsonArray();
        content["pages"] = new JsonArray(new JsonObject { ["pageNumber"] = 2, ["spans"] = new JsonArray() });
        content["figures"] = new JsonArray(Figure("2.1", 0));
        var package = Adapt(content);
        Assert.Equal(2, Assert.Single(package.LiteralPages).PageNumber);
        Assert.Empty(package.LiteralMarkdown);
        Assert.Empty(package.EvidenceLocations);
        Assert.Equal([2], Assert.Single(ContentUnderstandingAssets.Discover(package)).Pages);
    }

    [Theory]
    [InlineData("")]
    [InlineData("A(2,0,0,1,1)")]
    [InlineData("D(0,0,0,1,1)")]
    [InlineData("D(3,0,0,1,1)")]
    [InlineData("D(999999999999999999999,0,0,1,1)")]
    public void EmptyFigureRequiresAnExplicitPageInItsOwnContent(string source)
    {
        var content = Content();
        var figure = Figure("2.1", 4);
        figure["source"] = source;
        content["figures"] = new JsonArray(figure);
        var error = Assert.Throws<InvalidDataException>(() => Adapt(content));
        Assert.Contains("empty span without a valid source page", error.Message);
        Assert.DoesNotContain("Generated description", error.Message);
    }

    [Fact]
    public void EmptyFigureRequiresAnImageIdAndAnInBoundsUtf16Offset()
    {
        var content = Content();
        var figure = Figure("", 8);
        content["figures"] = new JsonArray(figure);
        Assert.Throws<InvalidDataException>(() => Adapt(content));
        figure["id"] = "2.1";
        figure["span"]!["offset"] = 17;
        Assert.Throws<InvalidDataException>(() => Adapt(content));
    }

    [Fact]
    public void EmptyFigureDoesNotConcealMissingLiteralText()
    {
        var content = Content();
        content["paragraphs"]!.AsArray().RemoveAt(1);
        content["figures"] = new JsonArray(Figure("2.1", 8));
        Assert.Contains("uncovered Markdown", Assert.Throws<InvalidDataException>(() => Adapt(content)).Message);
    }

    [Fact]
    public void NonemptyFigureOutsidePageSpansRemainsInvalid()
    {
        var content = Content();
        content["pages"]!.AsArray().RemoveAt(1);
        var figure = Figure("2.1", 8);
        figure["source"] = "D(1,0,0,1,0,1,1,0,1)";
        figure["span"]!["length"] = 8;
        content["figures"] = new JsonArray(figure);
        content["paragraphs"]!.AsArray().RemoveAt(1);
        Assert.Contains("outside all page spans", Assert.Throws<InvalidDataException>(() => Adapt(content)).Message);
    }

    private static JsonObject Content() => JsonNode.Parse("""
        {"mimeType":"application/pdf","markdown":"Page onePage two",
         "pages":[{"pageNumber":1,"spans":[{"offset":0,"length":8}]},
                  {"pageNumber":2,"spans":[{"offset":8,"length":8}]}],
         "paragraphs":[{"content":"Page one","span":{"offset":0,"length":8}},
                       {"content":"Page two","span":{"offset":8,"length":8}}]}
        """)!.AsObject();

    private static JsonObject Figure(string id, int offset) => new()
    {
        ["id"] = id, ["description"] = "Generated description",
        ["span"] = new JsonObject { ["offset"] = offset, ["length"] = 0 },
        ["source"] = "D(2,0,0,1,0,1,1,0,1)"
    };

    private static ExtractionPackage Adapt(JsonObject content) => ContentUnderstandingAdapter.Convert(
        JsonSerializer.SerializeToElement(new { status = "Succeeded", result = new
        {
            analyzerId = "test", apiVersion = "2025-11-01", stringEncoding = "utf16", contents = new[] { content }
        } }), new("source.pdf", "source.pdf", "source", "account"), "document", "test", "one", new string('a', 64), new string('b', 64));
}
