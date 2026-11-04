namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

/// <summary>Marks Document Intelligence page boundaries without dropping or duplicating source text.</summary>
public static class DocumentIntelligencePageMarkdown
{
    public const string PageBreak = "<!-- PageBreak -->";

    public static string Insert(string content, IReadOnlyList<(int PageNumber, int? Start)> pages)
    {
        if (pages.Count == 0) throw new InvalidDataException("Document Intelligence returned no pages.");
        var starts = new int[pages.Count];
        for (int index = 0; index < pages.Count; index++)
        {
            if (pages[index].PageNumber != index + 1)
                throw new InvalidDataException("Document Intelligence page numbers are not consecutive.");
            int start = index == 0 ? 0 : pages[index].Start ??
                pages.Skip(index + 1).Select(page => page.Start).FirstOrDefault(value => value is not null) ?? content.Length;
            if (start < 0 || start > content.Length || (index > 0 && start < starts[index - 1]))
                throw new InvalidDataException("Document Intelligence page spans are out of order.");
            starts[index] = start;
        }
        // Layout Markdown already contains page breaks for some API versions. Adding
        // another set doubles the apparent page count and invalidates citations.
        int existingBreaks = 0;
        for (int offset = 0; (offset = content.IndexOf(PageBreak, offset, StringComparison.Ordinal)) >= 0;
            offset += PageBreak.Length)
            existingBreaks++;
        if (existingBreaks == pages.Count - 1) return content;
        if (existingBreaks != 0)
            throw new InvalidDataException("Document Intelligence returned an inconsistent number of page breaks.");
        var parts = new string[pages.Count];
        for (int index = 0; index < pages.Count; index++)
        {
            int end = index + 1 < pages.Count ? starts[index + 1] : content.Length;
            parts[index] = content.Substring(starts[index], end - starts[index]);
        }
        return string.Join(PageBreak, parts);
    }
}
