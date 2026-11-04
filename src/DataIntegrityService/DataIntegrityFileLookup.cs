using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration.Helpers;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

public sealed class DataIntegrityFileLookup(BlobServiceClient blobs, DataIntegrityOptions options, ExtractionPolicy policy)
{
    public async Task<DocumentResponse?> FindExistingAsync(
        DocumentRequest request,
        CancellationToken cancellationToken)
    {
        if (request.Force == true)
        {
            return null;
        }

        var container = blobs.GetBlobContainerClient(options.OutputContainer);
        ExtractionRoute route;
        try { route = await policy.RouteAsync(request, blobs, cancellationToken); }
        catch (InvalidDataException) { return null; } // Transform reports the document error as HTTP 422.
        var identity = route.CacheIdentity;
        var filename = NameHelper.GenerateTempFileName(request, identity);
        var blob = container.GetBlobClient(filename);
        if (route.Provider == ExtractionPolicy.CuProvider && identity.Length > 0)
        {
            var packagePath = filename + ".extraction.json";
            var packageBlob = container.GetBlobClient(packagePath);
            if (!await blob.ExistsAsync(cancellationToken) || !await packageBlob.ExistsAsync(cancellationToken)) return null;
            var content = (await packageBlob.DownloadContentAsync(cancellationToken)).Value.Content;
            using var json = System.Text.Json.JsonDocument.Parse(content);
            var package = json.RootElement;
            if (!package.TryGetProperty("assets", out var assets) || assets.ValueKind != System.Text.Json.JsonValueKind.Array)
                return null; // Upgrade older packages from their saved CU operation.
            if (package.GetProperty("mediaType").GetString() == "document" &&
                (!package.TryGetProperty("markdownCoverageVersion", out var coverage) ||
                 coverage.ValueKind != System.Text.Json.JsonValueKind.Number || coverage.GetInt32() != 1))
                return null; // Revalidate saved results without another paid analysis submission.
            if (package.GetProperty("version").GetInt32() != 1 || package.GetProperty("accountId").GetString() != request.AccountId ||
                package.GetProperty("sourceId").GetString() != request.SourceId || package.GetProperty("configurationHash").GetString() != identity ||
                package.GetProperty("stringEncoding").GetString() != "utf16" ||
                string.IsNullOrWhiteSpace(package.GetProperty("analysisId").GetString()))
                throw new InvalidDataException("Cached extraction package provenance differs from this request.");
            return new(options.OutputContainer, filename, packagePath, package.GetProperty("analysisId").GetString());
        }
        if (await blob.ExistsAsync(cancellationToken))
        {
            return new DocumentResponse(options.OutputContainer, filename);
        }

        await foreach (var blobItem in container.GetBlobsAsync(
            traits: BlobTraits.None,
            states: BlobStates.Deleted,
            prefix: filename,
            cancellationToken: cancellationToken))
        {
            if (!string.Equals(blobItem.Name, filename, StringComparison.Ordinal)) continue;
            await blob.UndeleteAsync(cancellationToken);
            return new DocumentResponse(options.OutputContainer, filename);
        }

        return null;
    }
}
