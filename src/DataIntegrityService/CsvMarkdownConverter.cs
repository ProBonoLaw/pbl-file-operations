using System.Text;
using Microsoft.VisualBasic.FileIO;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

/// <summary>Read CSV cells as text, without spreadsheet type inference or formula evaluation.</summary>
public static class CsvMarkdownConverter
{
    public const int MaxSourceBytes = 128 * 1024 * 1024;
    public const int MaxRows = 20_000;
    public const int MaxColumns = 200;
    public const int MaxCellCharacters = 4_000;
    public const int MaxMarkdownCharacters = 8_000_000;

    public static string Convert(Stream source, CancellationToken cancellationToken = default)
    {
        using var parser = new TextFieldParser(source, new UTF8Encoding(false, true),
            detectEncoding: true, leaveOpen: true)
        {
            TextFieldType = FieldType.Delimited,
            HasFieldsEnclosedInQuotes = true,
            TrimWhiteSpace = false
        };
        parser.SetDelimiters(",");
        var rows = new List<string[]>();
        int columns = 0, characters = 0;
        try
        {
            while (!parser.EndOfData)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var fields = parser.ReadFields()!;
                if (rows.Count >= MaxRows || fields.Length > MaxColumns)
                    throw new InvalidDataException($"CSV exceeds {MaxRows} rows or {MaxColumns} columns.");
                for (int index = 0; index < fields.Length; index++)
                {
                    if (fields[index].Length > MaxCellCharacters)
                        throw new InvalidDataException($"CSV cell exceeds {MaxCellCharacters} characters.");
                    fields[index] = Escape(fields[index]);
                    characters += fields[index].Length;
                    if (characters > MaxMarkdownCharacters)
                        throw new InvalidDataException("CSV Markdown exceeds 8 million characters.");
                }
                rows.Add(fields);
                columns = Math.Max(columns, fields.Length);
            }
        }
        catch (MalformedLineException error)
        {
            throw new InvalidDataException($"Malformed CSV at line {error.LineNumber}.", error);
        }
        catch (DecoderFallbackException error)
        {
            throw new InvalidDataException("CSV must use UTF-8, or Unicode with a byte-order mark.", error);
        }
        if (rows.Count == 0) throw new InvalidDataException("CSV contains no records.");
        var markdown = new StringBuilder("## CSV\n\n");
        AppendRow(Enumerable.Range(1, columns).Select(column => $"Column {column}"));
        AppendRow(Enumerable.Repeat("---", columns));
        foreach (var row in rows)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AppendRow(Enumerable.Range(0, columns).Select(column => column < row.Length ? row[column] : ""));
        }
        return markdown.ToString().TrimEnd('\n');

        void AppendRow(IEnumerable<string> cells)
        {
            string line = "| " + string.Join(" | ", cells) + " |\n";
            if (markdown.Length + line.Length > MaxMarkdownCharacters)
                throw new InvalidDataException("CSV Markdown exceeds 8 million characters.");
            markdown.Append(line);
        }
    }

    private static string Escape(string value) => value
        .Replace("&", "&amp;", StringComparison.Ordinal)
        .Replace("<", "&lt;", StringComparison.Ordinal)
        .Replace(">", "&gt;", StringComparison.Ordinal)
        .Replace("\"", "&quot;", StringComparison.Ordinal)
        .Replace("\\", "\\\\", StringComparison.Ordinal)
        .Replace("|", "\\|", StringComparison.Ordinal)
        .Replace("\r\n", "<br/>", StringComparison.Ordinal)
        .Replace("\r", "<br/>", StringComparison.Ordinal)
        .Replace("\n", "<br/>", StringComparison.Ordinal);
}
