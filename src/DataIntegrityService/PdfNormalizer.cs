using System.Diagnostics;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

/// <summary>Removes an empty-user-password PDF encryption layer without re-rendering pages.</summary>
public static class PdfNormalizer
{
    public static async Task<byte[]> DecryptAsync(byte[] source, int expectedPages,
        CancellationToken cancellationToken)
    {
        string input = Path.GetTempFileName(), output = Path.GetTempFileName();
        try
        {
            await File.WriteAllBytesAsync(input, source, cancellationToken);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(TimeSpan.FromMinutes(2));
            using var process = new Process { StartInfo = new ProcessStartInfo("qpdf")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            } };
            foreach (string argument in new[] { "--decrypt", "--password=", input, output })
                process.StartInfo.ArgumentList.Add(argument);
            if (!process.Start()) throw new InvalidDataException("PDF normalization could not start.");
            var standardOutput = process.StandardOutput.ReadToEndAsync(deadline.Token);
            var standardError = process.StandardError.ReadToEndAsync(deadline.Token);
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
            await Task.WhenAll(standardOutput, standardError);
            if (process.ExitCode is not (0 or 3))
                throw new InvalidDataException("PDF encryption cannot be removed without a user password.");
            var inspection = await PdfPageCounter.InspectFileAsync(output, cancellationToken);
            if (inspection.Encrypted || inspection.Pages != expectedPages)
                throw new InvalidDataException("Normalized PDF does not preserve the source page count.");
            return await File.ReadAllBytesAsync(output, cancellationToken);
        }
        finally
        {
            File.Delete(input);
            File.Delete(output);
        }
    }
}
