using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;
using Azure.Storage.Blobs;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

public sealed record PdfInspection(int Pages, bool Encrypted);

/// <summary>Reads PDF page count locally, before a billable document analysis submission.</summary>
public static class PdfPageCounter
{
    public static async Task<PdfInspection> InspectAsync(BlobClient blob, CancellationToken cancellationToken)
    {
        string path = Path.GetTempFileName();
        try
        {
            var download = await blob.DownloadStreamingAsync(cancellationToken: cancellationToken);
            await using (var source = download.Value.Content)
            await using (var destination = File.Create(path))
                await source.CopyToAsync(destination, cancellationToken);
            return await InspectFileAsync(path, cancellationToken);
        }
        finally { File.Delete(path); }
    }

    public static async Task<int> CountFileAsync(string path, CancellationToken cancellationToken) =>
        (await InspectFileAsync(path, cancellationToken)).Pages;

    public static async Task<PdfInspection> InspectFileAsync(string path, CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(60));
        using var process = new Process { StartInfo = new ProcessStartInfo("pdfinfo")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        } };
        process.StartInfo.ArgumentList.Add(path);
        if (!process.Start()) throw new InvalidDataException("Unable to inspect PDF page count.");
        var output = process.StandardOutput.ReadToEndAsync(deadline.Token);
        var error = process.StandardError.ReadToEndAsync(deadline.Token);
        try { await process.WaitForExitAsync(deadline.Token); }
        catch (OperationCanceledException)
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None);
            }
            throw;
        }
        string details = await output;
        await error;
        if (process.ExitCode != 0) throw new InvalidDataException("PDF page count could not be read; the document may require a password or be damaged.");
        var match = Regex.Match(details, @"^Pages:\s*([0-9]+)\s*$", RegexOptions.Multiline);
        if (!match.Success || !int.TryParse(match.Groups[1].Value, NumberStyles.None,
                CultureInfo.InvariantCulture, out int pages) || pages < 1)
            throw new InvalidDataException("PDF has no valid page count.");
        var encrypted = Regex.Match(details, @"^Encrypted:\s*(yes|no)\b", RegexOptions.Multiline);
        if (!encrypted.Success) throw new InvalidDataException("PDF encryption status could not be read.");
        return new(pages, encrypted.Groups[1].Value == "yes");
    }
}
