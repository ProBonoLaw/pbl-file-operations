using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Azure;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Spreadsheet;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

public sealed class OfficePdfRenderer(string executable = "soffice")
{
    public const string RendererVersion = "libreoffice-pdf-v2";
    public static bool Supports(string filename) => Path.GetExtension(filename).ToLowerInvariant() is ".docx" or ".pptx" or ".xlsx";

    public static bool RequiresPdf(Stream source, string filename)
    {
        var extension = Path.GetExtension(filename).ToLowerInvariant();
        if (extension is ".docx" or ".pptx") return true;
        if (extension != ".xlsx") return false;
        using var spreadsheet = SpreadsheetDocument.Open(source, false, new OpenSettings { MaxCharactersInPart = 128_000_000 });
        var workbook = spreadsheet.WorkbookPart ?? throw new InvalidDataException("XLSX workbook could not be loaded.");
        // Include pictures in drawings, headers/footers, and other workbook relationships.
        return ContainsImage(workbook, new HashSet<Uri>());

        static bool ContainsImage(OpenXmlPart part, HashSet<Uri> visited)
        {
            if (!visited.Add(part.Uri)) return false;
            return part.Parts.Any(child => child.OpenXmlPart is ImagePart || ContainsImage(child.OpenXmlPart, visited));
        }
    }

    public async Task<bool> RequiresPdfAsync(BlobClient original, string filename, CancellationToken cancellationToken)
    {
        if (Path.GetExtension(filename).ToLowerInvariant() is ".docx" or ".pptx") return true;
        if (!Supports(filename)) return false;
        var properties = await original.GetPropertiesAsync(cancellationToken: cancellationToken);
        if (properties.Value.ContentLength > 200L * 1024 * 1024) throw new InvalidDataException("Office source exceeds 200 MB.");
        string input = Path.Combine(Path.GetTempPath(), "file-operations-workbook-" + Guid.NewGuid().ToString("N") + ".xlsx");
        try
        {
            var download = await original.DownloadStreamingAsync(new BlobDownloadOptions
                { Conditions = new BlobRequestConditions { IfMatch = properties.Value.ETag } }, cancellationToken);
            await using (var file = File.Create(input))
            await using (var content = download.Value.Content) await content.CopyToAsync(file, cancellationToken);
            using var source = File.OpenRead(input);
            return RequiresPdf(source, filename);
        }
        finally { if (File.Exists(input)) File.Delete(input); }
    }

    public async Task<SourceRendition> RenderAsync(BlobClient original, BlobClient output, string filename,
        CancellationToken cancellationToken, BlobContainerClient? retainedRenditions = null)
    {
        if (!Supports(filename)) throw new ArgumentException("Only DOCX, PPTX, and XLSX use Office PDF rendering.");
        var properties = await original.GetPropertiesAsync(cancellationToken: cancellationToken);
        if (properties.Value.ContentLength > 200L * 1024 * 1024) throw new InvalidDataException("Office source exceeds 200 MB.");
        string directory = Path.Combine(Path.GetTempPath(), "file-operations-office-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string input = Path.Combine(directory, "source" + Path.GetExtension(filename).ToLowerInvariant());
            var download = await original.DownloadStreamingAsync(new BlobDownloadOptions
                { Conditions = new BlobRequestConditions { IfMatch = properties.Value.ETag } }, cancellationToken);
            await using (var file = File.Create(input))
            await using (var content = download.Value.Content)
                await content.CopyToAsync(file, cancellationToken);
            BlobClient? receipt = null;
            if (retainedRenditions is not null)
            {
                string originalHash;
                await using (var file = File.OpenRead(input)) originalHash = Convert.ToHexStringLower(await SHA256.HashDataAsync(file, cancellationToken));
                string version = (await RunAsync(["--version"], directory, cancellationToken)).Trim();
                string rendererHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(RendererVersion + "|" + version)));
                receipt = retainedRenditions.GetBlobClient($"renditions/{originalHash}/{rendererHash}.json");
                if (await receipt.ExistsAsync(cancellationToken))
                {
                    var cached = (await receipt.DownloadContentAsync(cancellationToken)).Value.Content.ToObjectFromJson<SourceRendition>();
                    if (cached is null || cached.OriginalSha256 != originalHash || cached.Renderer != RendererVersion || cached.RendererVersion != version)
                        throw new InvalidDataException("Office rendition cache provenance differs from the renderer.");
                    var stored = await retainedRenditions.GetBlobClient(cached.ContainerPath).DownloadStreamingAsync(cancellationToken: cancellationToken);
                    await using var pdfStream = stored.Value.Content;
                    await output.UploadAsync(pdfStream, new BlobUploadOptions { HttpHeaders = new BlobHttpHeaders { ContentType = "application/pdf" } }, cancellationToken);
                    return cached with { OriginalFilename = filename };
                }
            }
            string pdf = Path.Combine(directory, "source.pdf");
            var rendition = await RenderFileAsync(input, pdf, filename, cancellationToken);
            await using var rendered = File.OpenRead(pdf);
            await output.UploadAsync(rendered, new BlobUploadOptions { HttpHeaders = new BlobHttpHeaders { ContentType = "application/pdf" } }, cancellationToken);
            if (retainedRenditions is not null)
            {
                string path = $"renditions/{rendition.OriginalSha256}/{rendition.PdfSha256}.pdf";
                rendered.Position = 0;
                try
                {
                    await retainedRenditions.GetBlobClient(path).UploadAsync(rendered, new BlobUploadOptions
                    {
                        Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All },
                        HttpHeaders = new BlobHttpHeaders { ContentType = "application/pdf" }
                    }, cancellationToken);
                }
                catch (RequestFailedException error) when (error.Status is 409 or 412) { }
                rendition = rendition with { ContainerName = retainedRenditions.Name, ContainerPath = path };
                try { await receipt!.UploadAsync(BinaryData.FromObjectAsJson(rendition), overwrite: false, cancellationToken); }
                catch (RequestFailedException error) when (error.Status == 409) { }
            }
            return rendition;
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    public async Task<SourceRendition> RenderFileAsync(string input, string pdf, string filename,
        CancellationToken cancellationToken)
    {
        if (!Supports(input) || !Supports(filename)) throw new ArgumentException("Only DOCX, PPTX, and XLSX use Office PDF rendering.");
        if (new FileInfo(input).Length > 200L * 1024 * 1024) throw new InvalidDataException("Office source exceeds 200 MB.");
        string originalHash;
        await using (var file = File.OpenRead(input)) originalHash = Convert.ToHexStringLower(await SHA256.HashDataAsync(file, cancellationToken));
        string directory = Path.GetDirectoryName(Path.GetFullPath(pdf))!;
        Directory.CreateDirectory(directory);
        string profile = Path.Combine(directory, "profile-" + Guid.NewGuid().ToString("N"));
        string? workbookDirectory = null;
        try
        {
            string renderInput = input;
            bool workbook = Path.GetExtension(input).Equals(".xlsx", StringComparison.OrdinalIgnoreCase);
            if (workbook)
            {
                workbookDirectory = Path.Combine(directory, "workbook-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(workbookDirectory);
                renderInput = Path.Combine(workbookDirectory, Path.GetFileName(input));
                File.Copy(input, renderInput);
                PrepareWorkbook(renderInput);
            }
            string version = await RunAsync(["--version"], directory, cancellationToken);
            await RunAsync([
                "-env:UserInstallation=" + new Uri(profile).AbsoluteUri,
                "--headless", "--nologo", "--nodefault", "--nofirststartwizard", "--norestore",
                "--convert-to", workbook ? "pdf:calc_pdf_Export" : "pdf", "--outdir", directory, Path.GetFullPath(renderInput)
            ], directory, cancellationToken);
            string actualPdf = Path.Combine(directory, Path.GetFileNameWithoutExtension(input) + ".pdf");
            if (!File.Exists(actualPdf) || new FileInfo(actualPdf).Length == 0) throw new InvalidDataException("Office renderer produced no PDF.");
            if (Path.GetFullPath(actualPdf) != Path.GetFullPath(pdf)) File.Move(actualPdf, pdf, overwrite: true);
            await using var rendered = File.OpenRead(pdf);
            var header = new byte[5];
            await rendered.ReadExactlyAsync(header, cancellationToken);
            if (!header.SequenceEqual("%PDF-"u8.ToArray())) throw new InvalidDataException("Office renderer produced an invalid PDF.");
            rendered.Position = 0;
            string renderedHash = Convert.ToHexStringLower(await SHA256.HashDataAsync(rendered, cancellationToken));
            return new(filename, originalHash, renderedHash, RendererVersion, version.Trim());
        }
        finally
        {
            if (Directory.Exists(profile)) Directory.Delete(profile, recursive: true);
            if (workbookDirectory is not null) Directory.Delete(workbookDirectory, recursive: true);
        }
    }

    private static void PrepareWorkbook(string path)
    {
        // Normalize only the disposable rendering copy: stale print ranges and hidden sheets
        // must not hide pictures, and horizontal pagination must not split table columns.
        using var spreadsheet = SpreadsheetDocument.Open(path, true, new OpenSettings { MaxCharactersInPart = 128_000_000 });
        var workbook = spreadsheet.WorkbookPart ?? throw new InvalidDataException("XLSX workbook could not be loaded.");
        foreach (var sheet in workbook.Workbook.Sheets?.Elements<Sheet>() ?? []) sheet.State = SheetStateValues.Visible;
        foreach (var name in workbook.Workbook.DefinedNames?.Elements<DefinedName>().Where(name =>
            name.Name?.Value is "_xlnm.Print_Area" or "_xlnm.Print_Titles").ToArray() ?? []) name.Remove();
        foreach (var worksheet in workbook.WorksheetParts)
        {
            var properties = worksheet.Worksheet.GetFirstChild<SheetProperties>();
            if (properties is null) { properties = new SheetProperties(); worksheet.Worksheet.AddChild(properties, true); }
            properties.PageSetupProperties = new PageSetupProperties { FitToPage = true };
            var setup = worksheet.Worksheet.GetFirstChild<PageSetup>();
            if (setup is null) { setup = new PageSetup(); worksheet.Worksheet.AddChild(setup, true); }
            setup.FitToWidth = 1;
            setup.FitToHeight = 0;
            setup.Scale = null;
            setup.Orientation = OrientationValues.Landscape;
            foreach (var anchor in worksheet.DrawingsPart?.WorksheetDrawing?.Descendants<DocumentFormat.OpenXml.Drawing.Spreadsheet.ClientData>() ?? [])
                anchor.PrintWithSheet = true;
            worksheet.DrawingsPart?.WorksheetDrawing?.Save();
            worksheet.Worksheet.Save();
        }
        workbook.Workbook.Save();
    }

    private async Task<string> RunAsync(IEnumerable<string> arguments, string directory, CancellationToken cancellationToken)
    {
        var start = new ProcessStartInfo(executable)
        {
            WorkingDirectory = directory, UseShellExecute = false, RedirectStandardOutput = true,
            RedirectStandardError = true, CreateNoWindow = true
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Unable to start LibreOffice.");
        var stdout = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderr = process.StandardError.ReadToEndAsync(cancellationToken);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMinutes(3));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch { if (!process.HasExited) process.Kill(entireProcessTree: true); throw; }
        var text = await stdout;
        await stderr;
        if (process.ExitCode != 0) throw new InvalidDataException($"Office PDF rendering failed with exit code {process.ExitCode}.");
        return text;
    }
}
