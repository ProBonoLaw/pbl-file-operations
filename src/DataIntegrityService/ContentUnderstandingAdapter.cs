using System.Net;
using System.Text.Json;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

public static class ContentUnderstandingAdapter
{
    public static ExtractionPackage Convert(JsonElement response, DocumentRequest request,
        string media, string analyzerId, string analysisId, string configurationHash, string sourceHash)
    {
        if (!response.TryGetProperty("status", out var status) ||
            !string.Equals(status.GetString(), "Succeeded", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("CU analysis did not succeed.");
        var result = response.GetProperty("result");
        if (Text(result, "stringEncoding") != "utf16" || Text(result, "analyzerId") != analyzerId ||
            Text(result, "apiVersion") != ContentUnderstandingOptions.ApiVersion)
            throw new InvalidDataException("CU result provenance differs from the requested analyzer, API or UTF-16 encoding.");
        var blocks = new List<ExtractionBlock>();
        var pageKinds = new SortedDictionary<int, string>();
        int contentIndex = 0;
        foreach (var content in Array(result, "contents"))
        {
            if (media == "document") AddDocument(content, contentIndex, blocks, pageKinds);
            else AddMedia(content, contentIndex, request, analysisId, blocks);
            AddFields(content, contentIndex, blocks, media);
            contentIndex++;
        }
        if (contentIndex == 0) throw new InvalidDataException("CU returned no content.");
        if (media != "document")
        {
            // Segmented video repeats whole phrases at boundaries. Preserve one
            // phrase with its complete time range in chronological order.
            var transcript = blocks.Where(b => b.Kind == "transcript")
                .DistinctBy(b => (b.StartTimeMs, b.EndTimeMs, b.Speaker, b.Text))
                .OrderBy(b => b.StartTimeMs).ThenBy(b => b.EndTimeMs).ToArray();
            blocks = transcript.Concat(blocks.Where(b => b.Kind != "transcript")).ToList();
            pageKinds[1] = "media";
        }
        var pages = new List<LiteralPage>();
        var locations = new List<EvidenceLocation>();
        foreach (var (pageNumber, kind) in pageKinds)
        {
            var text = new System.Text.StringBuilder();
            foreach (var block in blocks.Where(b => b.Origin == "extracted" &&
                (media != "document" || b.Pages.FirstOrDefault() == pageNumber)))
            {
                if (text.Length > 0) text.Append("\n\n");
                int offset = text.Length;
                text.Append(block.Text);
                locations.Add(new(pageNumber, offset, block.Text.Length, block.Id, block.Pages,
                    block.Regions, block.StartTimeMs, block.EndTimeMs, block.Speaker));
            }
            pages.Add(new(pageNumber, text.ToString(), kind));
        }
        return new(1, request.AccountId, request.SourceId, media, ExtractionPolicy.CuProvider, analyzerId, ContentUnderstandingOptions.ApiVersion,
            analysisId, configurationHash, sourceHash, "utf16", string.Join("<!-- PageBreak -->", pages.Select(p => p.Text)),
            pages, blocks, locations, response.Clone(), response.TryGetProperty("usage", out var usage) ? usage.Clone() : null,
            Array(result, "warnings").Select(w => w.Clone()).ToArray(), request.Rendition, request.Metadata,
            MarkdownCoverageVersion: media == "document" ? 1 : null);
    }

    private static void AddDocument(JsonElement content, int index, List<ExtractionBlock> blocks,
        SortedDictionary<int, string> pageKinds)
    {
        string markdown = content.GetProperty("markdown").GetString() ?? "";
        var pages = Array(content, "pages").ToArray();
        if (pages.Length == 0) throw new InvalidDataException("CU document has no structured pages; enable returnDetails.");
        var ranges = new List<(int Page, ServiceSpan Span)>();
        foreach (var page in pages)
        {
            int number = page.GetProperty("pageNumber").GetInt32();
            if (number < 1 || pageKinds.ContainsKey(number)) throw new InvalidDataException("Invalid or duplicate CU page.");
            pageKinds[number] = Text(content, "mimeType") is "application/pdf" or "image/tiff" ||
                Text(content, "mimeType").StartsWith("image/", StringComparison.Ordinal) ? "physical-page" : "logical-page";
            foreach (var span in Array(page, "spans")) ranges.Add((number, Span(span, index, markdown)));
        }
        var orderedRanges = ranges.OrderBy(r => r.Span.Offset).ToArray();
        for (int i = 1; i < orderedRanges.Length; i++)
            if (Overlaps(orderedRanges[i - 1].Span, orderedRanges[i].Span))
                throw new InvalidDataException("CU page spans overlap.");
        var tables = Array(content, "tables").Select(t => (Element: t, Span: Span(t.GetProperty("span"), index, markdown))).ToArray();
        var extracted = new List<ExtractionBlock>();
        foreach (var (table, span) in tables)
        {
            var cells = Array(table, "cells").ToArray();
            if (cells.Length == 0) throw new InvalidDataException("CU table has no literal cells.");
            var html = new System.Text.StringBuilder("<table>\n");
            var caption = table.TryGetProperty("caption", out var cap) ? Text(cap, "content") : "";
            if (caption.Length > 0) html.Append("<caption>").Append(WebUtility.HtmlEncode(caption)).Append("</caption>\n");
            foreach (var row in cells.GroupBy(c => c.GetProperty("rowIndex").GetInt32()).OrderBy(g => g.Key))
            {
                html.Append("<tr>");
                foreach (var cell in row.OrderBy(c => c.GetProperty("columnIndex").GetInt32()))
                {
                    string tag = Text(cell, "kind") is "columnHeader" or "rowHeader" ? "th" : "td";
                    html.Append('<').Append(tag);
                    foreach (string name in new[] { "rowSpan", "columnSpan" })
                        if (cell.TryGetProperty(name, out var count) && count.GetInt32() > 1)
                            html.Append(name == "rowSpan" ? " rowspan=\"" : " colspan=\"").Append(count.GetInt32()).Append('"');
                    html.Append('>').Append(WebUtility.HtmlEncode(Text(cell, "content"))).Append("</").Append(tag).Append('>');
                }
                html.Append("</tr>\n");
            }
            html.Append("</table>");
            foreach (var footnote in Array(table, "footnotes")) html.Append('\n').Append(Text(footnote, "content"));
            extracted.Add(Block("table", html.ToString(), span, table, ranges,
                cells.Select(c => Text(c, "source")).Where(s => s.Length > 0)));
        }
        foreach (var paragraph in Array(content, "paragraphs"))
        {
            var span = Span(paragraph.GetProperty("span"), index, markdown);
            if (tables.Any(t => Contains(t.Span, span))) continue;
            var text = Text(paragraph, "content");
            if (text.Length == 0) continue;
            var role = Text(paragraph, "role");
            extracted.Add(Block(role is "title" or "sectionHeading" ? "heading" : "paragraph", text, span, paragraph, ranges));
        }
        // Recover OCR words not represented in paragraphs or tables, including text inside figures.
        foreach (var page in pages)
        {
            foreach (string elementName in new[] { "formulas", "barcodes" })
            foreach (var element in Array(page, elementName))
            {
                var span = Span(element.GetProperty("span"), index, markdown);
                if (extracted.Any(b => b.ServiceSpans.Any(s => Contains(s, span)))) continue;
                string value = Text(element, "value");
                if (value.Length > 0) extracted.Add(Block(elementName == "formulas" ? "formula" : "barcode", value, span, element, ranges));
            }
            foreach (var word in Array(page, "words"))
            {
                var span = Span(word.GetProperty("span"), index, markdown);
                if (extracted.Any(b => b.ServiceSpans.Any(s => Contains(s, span)))) continue;
                if (Text(word, "content").Length > 0)
                    extracted.Add(Block("ocr", Text(word, "content"), span, word, ranges));
            }
        }
        blocks.AddRange(extracted.OrderBy(b => b.ServiceSpans[0].Offset));
        foreach (var figure in Array(content, "figures"))
        {
            var span = Span(figure.GetProperty("span"), index, markdown);
            var text = Text(figure, "description");
            if (figure.TryGetProperty("content", out var analysis)) text += "\n" + Render(analysis);
            blocks.Add(FigureBlock(text.Trim().Length == 0 ? "figure" : "figure-description",
                text.Trim().Length == 0 ? "Document figure" : text.Trim(), span, figure, ranges, pages)
                with { Origin = text.Trim().Length == 0 ? "artifact" : "generated" });
        }
        foreach (var annotation in Array(content, "annotations"))
        {
            string comments = string.Join("\n", Array(annotation, "comments").Select(c =>
                $"{Text(c, "author")}: {Text(c, "message")}"));
            if (!comments.Trim().Any()) continue;
            var spans = Array(annotation, "spans").Select(s => Span(s, index, markdown)).ToArray();
            var region = Text(annotation, "source");
            var pageNumbers = spans.SelectMany(s => ranges.Where(r => Overlaps(r.Span, s)).Select(r => r.Page)).Distinct().Order().ToArray();
            if (pageNumbers.Length == 0 && System.Text.RegularExpressions.Regex.Match(region, @"^D\((\d+),") is { Success: true } match)
                pageNumbers = [int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture)];
            if (pageNumbers.Length == 0 || pageNumbers.Any(p => !pageKinds.ContainsKey(p)))
                throw new InvalidDataException("CU annotation lacks a source page.");
            blocks.Add(new($"{index}:annotation:{Text(annotation, "id")}", "annotation", "extracted", comments,
                pageNumbers, region.Length > 0 ? [region] : [], spans));
        }
        // Annotation spans point to annotated source text, not the comment text retained above.
        // They must not conceal missing paragraphs/OCR. Figure alt text is likewise literal.
        DocumentMarkdownCoverage.Validate(markdown, index, extracted, Array(content, "figures"));
    }

    private static ExtractionBlock FigureBlock(string kind, string text, ServiceSpan span, JsonElement figure,
        List<(int Page, ServiceSpan Span)> ranges, JsonElement[] contentPages)
    {
        if (span.Length > 0) return Block(kind, text, span, figure, ranges);
        // CU can retain a figure with no Markdown representation. Its insertion offset
        // is not a text interval; use the explicit source page, including on blank pages.
        string region = Text(figure, "source"), id = Text(figure, "id");
        var match = System.Text.RegularExpressions.Regex.Match(region, @"\AD\(([0-9]+),");
        if (id.Length == 0 || !match.Success ||
            !int.TryParse(match.Groups[1].Value, System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture, out int page) ||
            !contentPages.Any(p => p.GetProperty("pageNumber").GetInt32() == page))
            throw new InvalidDataException($"CU figure in content {span.ContentIndex} at UTF-16 offset {span.Offset} has an empty span without a valid source page or image ID.");
        // Multiple figures can share an insertion offset. Keep their asset links distinct.
        return new($"{span.ContentIndex}:figure-id:{id}", kind, "extracted", text, [page], [region], [span]);
    }

    private static ExtractionBlock Block(string kind, string text, ServiceSpan span, JsonElement element,
        List<(int Page, ServiceSpan Span)> ranges, IEnumerable<string>? extraRegions = null)
    {
        var pages = ranges.Where(r => Overlaps(r.Span, span)).Select(r => r.Page).Distinct().Order().ToArray();
        if (pages.Length == 0) throw new InvalidDataException("CU element falls outside all page spans.");
        var regions = (extraRegions ?? []).Append(Text(element, "source")).Where(s => s.Length > 0).Distinct().ToArray();
        return new($"{span.ContentIndex}:{kind}:{span.Offset}", kind, "extracted", text, pages, regions, [span]);
    }

    private static void AddMedia(JsonElement content, int index, DocumentRequest request, string analysisId,
        List<ExtractionBlock> blocks)
    {
        var (start, end) = Times(content);
        int phraseIndex = 0;
        foreach (var phrase in Array(content, "transcriptPhrases"))
        {
            var (phraseStart, phraseEnd) = Times(phrase);
            if (phraseEnd < start || phraseStart > end) throw new InvalidDataException("Transcript does not intersect its media segment.");
            string speaker = Text(phrase, "speaker");
            if (request.SpeakerNames is { Count: > 0 })
            {
                if (request.SpeakerAnalysisId != analysisId)
                    throw new ArgumentException("Speaker names must reference this CU analysis ID. Request fresh speaker feedback.");
                if (request.SpeakerNames.TryGetValue(speaker, out var name)) speaker = $"{name} ({speaker})";
            }
            string text = Text(phrase, "text");
            if (text.Length > 0) blocks.Add(new($"{index}:transcript:{phraseIndex}", "transcript", "extracted", text,
                [], [], [], phraseStart, phraseEnd, speaker));
            phraseIndex++;
        }
        var keyFrames = Array(content, "keyFrameTimesMs").Select(f => f.GetInt64()).ToArray();
        if (keyFrames.Any(t => t < start || t > end)) throw new InvalidDataException("Invalid key frame timestamp.");
        if (keyFrames.Length > 0) blocks.Add(new($"{index}:keyframes", "keyframes", "artifact",
            "Video key frames", [], [], [], start, end, KeyFrameTimesMs: keyFrames));
        // Silent video segments may omit transcriptPhrases. Analyzer returnDetails
        // is checked before submission, rather than inferred from speech presence.
    }

    private static void AddFields(JsonElement content, int index, List<ExtractionBlock> blocks, string media)
    {
        if (!content.TryGetProperty("fields", out var fields)) return;
        var times = media == "document" ? ((long?)null, (long?)null) : NullableTimes(content);
        foreach (var field in fields.EnumerateObject())
        {
            string value = FieldValue(field.Value);
            if (value.Length > 0) blocks.Add(new($"{index}:field:{field.Name}", "summary", "generated",
                $"{field.Name}: {value}", [], [], [], times.Item1, times.Item2));
        }
    }

    private static string FieldValue(JsonElement value)
    {
        foreach (var property in value.EnumerateObject())
            if (property.Name.StartsWith("value", StringComparison.Ordinal)) return Render(property.Value);
        return "";
    }
    private static string Render(JsonElement value) => value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : value.GetRawText();
    private static (long, long) Times(JsonElement element)
    {
        long start = element.GetProperty("startTimeMs").GetInt64(), end = element.GetProperty("endTimeMs").GetInt64();
        if (start < 0 || end < start) throw new InvalidDataException("Invalid media timing.");
        return (start, end);
    }
    private static (long?, long?) NullableTimes(JsonElement element) { var (start, end) = Times(element); return (start, end); }
    private static ServiceSpan Span(JsonElement value, int index, string markdown)
    {
        int offset = value.GetProperty("offset").GetInt32(), length = value.GetProperty("length").GetInt32();
        if (offset < 0 || length < 0 || (long)offset + length > markdown.Length)
            throw new InvalidDataException("Invalid UTF-16 CU span.");
        return new(index, offset, length);
    }
    private static bool Overlaps(ServiceSpan a, ServiceSpan b) => a.Offset < (long)b.Offset + b.Length && b.Offset < (long)a.Offset + a.Length;
    private static bool Contains(ServiceSpan a, ServiceSpan b) => a.Offset <= b.Offset && (long)a.Offset + a.Length >= (long)b.Offset + b.Length;
    private static IEnumerable<JsonElement> Array(JsonElement value, string name)
    {
        if (value.TryGetProperty(name, out var array) && array.ValueKind == JsonValueKind.Array) return array.EnumerateArray();
        // GA videoSearch currently emits KeyFrameTimesMs, whereas the REST schema
        // and other analyzers use keyFrameTimesMs.
        if (name == "keyFrameTimesMs" && value.TryGetProperty("KeyFrameTimesMs", out array)
            && array.ValueKind == JsonValueKind.Array) return array.EnumerateArray();
        return [];
    }
    private static string Text(JsonElement value, string name) => value.TryGetProperty(name, out var text)
        && text.ValueKind == JsonValueKind.String ? text.GetString() ?? "" : "";
}
