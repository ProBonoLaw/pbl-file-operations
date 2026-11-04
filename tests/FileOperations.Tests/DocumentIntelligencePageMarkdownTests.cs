using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using Xunit;

namespace FileOperations.Tests;

public class DocumentIntelligencePageMarkdownTests
{
    [Fact]
    public void InsertsOriginalPageBoundariesWithoutLosingSourceText()
    {
        const string text = "First page\n\nSecond page\n\nLast page";
        var pages = new (int PageNumber, int? Start)[] { (1, 0), (2, 12), (3, 25) };

        string marked = DocumentIntelligencePageMarkdown.Insert(text, pages);

        Assert.Equal(text, marked.Replace(DocumentIntelligencePageMarkdown.PageBreak, ""));
        Assert.Equal(3, marked.Split(DocumentIntelligencePageMarkdown.PageBreak).Length);
        Assert.Equal("First page\n\n", marked.Split(DocumentIntelligencePageMarkdown.PageBreak)[0]);
        Assert.Equal("Second page\n\n", marked.Split(DocumentIntelligencePageMarkdown.PageBreak)[1]);
    }

    [Fact]
    public void RetainsBlankPagesAndRejectsOutOfOrderSpans()
    {
        var pages = new (int PageNumber, int? Start)[] { (1, 0), (2, null), (3, 5) };
        Assert.Equal("hello" + DocumentIntelligencePageMarkdown.PageBreak +
            DocumentIntelligencePageMarkdown.PageBreak + " world",
            DocumentIntelligencePageMarkdown.Insert("hello world", pages));
        Assert.Throws<InvalidDataException>(() => DocumentIntelligencePageMarkdown.Insert("hello",
            [(1, 0), (2, 4), (3, 2)]));
    }

    [Fact]
    public void ReusesNativeLayoutPageBreaksWithoutDoublingThePageCount()
    {
        const string content = "First page\n<!-- PageBreak -->\nSecond page\n<!-- PageBreak -->\nLast page";
        var pages = new (int PageNumber, int? Start)[] { (1, 0), (2, 30), (3, 61) };

        Assert.Equal(content, DocumentIntelligencePageMarkdown.Insert(content, pages));
        Assert.Equal(3, DocumentIntelligencePageMarkdown.Insert(content, pages).Split(
            DocumentIntelligencePageMarkdown.PageBreak).Length);
    }

    [Fact]
    public void RejectsIncompleteNativePageBreaks()
    {
        const string content = "First<!-- PageBreak -->Second Third";
        Assert.Throws<InvalidDataException>(() => DocumentIntelligencePageMarkdown.Insert(content,
            [(1, 0), (2, 22), (3, 28)]));
    }
}
