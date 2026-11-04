using System.Text.Json;
using System.Text.RegularExpressions;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

/// <summary>Every Markdown character must belong to retained source text or recognized service formatting/enrichment.</summary>
internal static class DocumentMarkdownCoverage
{
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromSeconds(1);
    private static readonly Regex FigureImage = new(
        """!\[(?<alt>(?:\\[\s\S]|[^\\\]])*)\]\(figures/(?<id>[a-zA-Z0-9._-]+)(?:[ \t]+"(?:\\[\s\S]|[^"\\])*")?\)""",
        RegexOptions.CultureInvariant, RegexTimeout);
    private static readonly Regex AnalysisFence = new(
        @"\A\s*```(?<kind>chart|mermaid)[ \t]*\r?\n(?<body>[\s\S]*?)\r?\n```\s*\z",
        RegexOptions.CultureInvariant, RegexTimeout);
    private static readonly Regex Formatting = new(
        "<!-- PageBreak -->|<!-- PageNumber(?:=\"[0-9]+\"|: [0-9]+) -->|(?m:^#{1,6}[ \\t]+)",
        RegexOptions.CultureInvariant, RegexTimeout);
    private static readonly Regex PageFurniture = new(
        """<!-- Page(?:Header|Footer)(?::[ \t]*(?<content>(?:(?!-->)[\s\S])*?)|="(?<content>(?:(?!-->)[\s\S])*?)")[ \t]*-->""",
        RegexOptions.CultureInvariant, RegexTimeout);

    public static void Validate(string markdown, int index, IEnumerable<ExtractionBlock> extracted,
        IEnumerable<JsonElement> figures)
    {
        var covered = extracted.SelectMany(block => block.ServiceSpans).ToList();
        foreach (var figure in figures)
        {
            int offset = figure.GetProperty("span").GetProperty("offset").GetInt32();
            int length = figure.GetProperty("span").GetProperty("length").GetInt32();
            string text = markdown.Substring(offset, length); // The adapter has already validated the UTF-16 span.
            // Figure spans may start with a literal caption before the image link.
            // Recognize only this figure's link; the caption still needs literal coverage.
            var image = FigureImage.Matches(text).Cast<Match>().FirstOrDefault(match =>
                match.Groups["id"].Value == figure.GetProperty("id").GetString());
            if (image is null) continue; // An unrecognized figure representation must pass literal coverage instead.
            var alt = image.Groups["alt"];
            // The alt text is detected source text. Never mask it with the encompassing figure span.
            covered.Add(new(index, offset + image.Index, alt.Index - image.Index));
            covered.Add(new(index, offset + alt.Index + alt.Length, image.Index + image.Length - alt.Index - alt.Length));
            int imageEnd = image.Index + image.Length;
            string analysisText = text[imageEnd..];
            if (figure.TryGetProperty("content", out var analysis) && MatchesAnalysis(analysisText, analysis))
                covered.Add(new(index, offset + imageEnd, analysisText.Length));
        }
        foreach (Match match in PageFurniture.Matches(markdown))
        {
            var content = match.Groups["content"];
            // Only the service wrapper is formatting. Header/footer text and figure alt text
            // still need independent paragraph/OCR coverage, just like the document body.
            covered.Add(new(index, match.Index, content.Index - match.Index));
            covered.Add(new(index, content.Index + content.Length,
                match.Index + match.Length - content.Index - content.Length));
        }
        foreach (Match match in Formatting.Matches(markdown)) covered.Add(new(index, match.Index, match.Length));
        int cursor = 0;
        foreach (var span in covered.Where(span => span.ContentIndex == index && span.Length > 0).OrderBy(span => span.Offset))
        {
            if (span.Offset > cursor) RequireWhitespace(cursor, span.Offset);
            cursor = Math.Max(cursor, span.Offset + span.Length);
        }
        RequireWhitespace(cursor, markdown.Length);

        void RequireWhitespace(int start, int end)
        {
            for (int position = start; position < end; position++)
                if (!char.IsWhiteSpace(markdown[position]))
                    throw new InvalidDataException($"CU document content {index} has uncovered Markdown at UTF-16 offset {position}; package publication rejected.");
        }
    }

    private static bool MatchesAnalysis(string text, JsonElement analysis)
    {
        var fence = AnalysisFence.Match(text);
        string body = fence.Success ? fence.Groups["body"].Value : text.Trim();
        if (analysis.ValueKind == JsonValueKind.String)
            return body.ReplaceLineEndings("\n").Trim() == (analysis.GetString() ?? "").ReplaceLineEndings("\n").Trim();
        if (!fence.Success || fence.Groups["kind"].Value != "chart") return false;
        try
        {
            using var json = JsonDocument.Parse(body);
            return JsonElement.DeepEquals(json.RootElement, analysis);
        }
        catch (JsonException) { return false; }
    }
}
