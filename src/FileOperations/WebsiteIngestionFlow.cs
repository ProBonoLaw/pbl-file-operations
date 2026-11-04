using System.Text.Json;
using Azure.Storage.Blobs;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

namespace FileOperations;

public sealed class WebsiteIngestionFlow
{
    private static readonly HashSet<string> DocumentExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".pdf", ".docx", ".pptx", ".xlsx", ".csv", ".jpg", ".gif", ".png", ".jpeg"
    };

    internal static bool IsDocumentUri(Uri sourceUri) => DocumentExtensions.Contains(Path.GetExtension(GetFilename(sourceUri)));

    private readonly HttpClient client;
    private readonly BlobServiceClient blobs = Settings.StorageBlobs();
    private readonly HttpFunctions functions;
    private readonly ILogger<WebsiteIngestionFlow>? logger;

    public WebsiteIngestionFlow(HttpClient client, HttpFunctions functions,
        ILogger<WebsiteIngestionFlow>? logger = null)
    {
        this.client = client;
        this.functions = functions;
        this.logger = logger;
    }

    public async Task ProcessAsync(JsonElement content, CancellationToken cancellationToken)
        => await ProcessAsync(content, null, cancellationToken);

    public async Task ProcessAsync(JsonElement content, EventOrder? eventOrder,
        CancellationToken cancellationToken)
    {
        var accountId = RequiredString(content, "accountId");
        var identifier = RequiredString(content, "identifier");
        var sourceUrl = RequiredString(content, "url");
        if (!TryCreateSourceUri(sourceUrl, out var sourceUri))
            throw new InvalidDataException("Website ingestion URL must be an absolute HTTP or HTTPS URL");

        var filename = GetFilename(sourceUri!);
        if (!IsDocumentUri(sourceUri!))
        {
            logger?.LogInformation("Sending website URL to the Data Ingestion API");
            await functions.IngestDocumentAsync(new
            {
                accountId,
                containerName = "",
                containerPath = "",
                documentName = "",
                isCurrentOrder = false,
                isWebSite = true,
                sourceId = identifier,
                sourceUrl,
                eventOrder
            }, cancellationToken);
            return;
        }

        var rawBlobName = Guid.NewGuid().ToString();
        var inputBlob = blobs.GetBlobContainerClient("input").GetBlobClient(rawBlobName);
        logger?.LogInformation("Downloading website document and staging it for conversion");
        using (var response = await client.GetAsync(sourceUri, HttpCompletionOption.ResponseHeadersRead,
            cancellationToken))
        {
            response.EnsureSuccessStatusCode();
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            await inputBlob.UploadAsync(stream, overwrite: false, cancellationToken);
        }

        logger?.LogInformation("Converting website document to Markdown");
        var conversionInput = new Dictionary<string, object?>
        {
            ["containerName"] = "input",
            ["containerPath"] = rawBlobName,
            ["filePath"] = sourceUrl,
            ["filename"] = filename,
            ["modifiedDate"] = null,
            ["sourceId"] = identifier,
            ["accountId"] = accountId,
            ["force"] = BooleanValue(content, "force"),
            ["highRes"] = BooleanValue(content, "highRes")
        };
        string? renderedPath = null;
        var officeRenderer = new OfficePdfRenderer(Settings.Get("OFFICE_PDF_RENDERER") ?? "soffice");
        if (await officeRenderer.RequiresPdfAsync(inputBlob, filename, cancellationToken))
        {
            renderedPath = rawBlobName + ".pdf";
            var rendered = blobs.GetBlobContainerClient("input").GetBlobClient(renderedPath);
            conversionInput["rendition"] = await officeRenderer.RenderAsync(inputBlob, rendered, filename, cancellationToken, blobs.GetBlobContainerClient("results"));
            conversionInput["containerPath"] = renderedPath;
        }
        var conversion = await functions.TransformMarkdownAsync(conversionInput, cancellationToken);
        var (resultContainer, resultPath) = IngestionFlow.Location(conversion);
        var (extractionPath, _) = IngestionFlow.ExtractionLocation(conversion);

        logger?.LogInformation("Submitting converted website document to the Data Ingestion API");
        await functions.IngestDocumentAsync(new
        {
            accountId,
            containerName = resultContainer,
            containerPath = resultPath,
            extractionContainerPath = extractionPath,
            documentName = filename,
            isCurrentOrder = false,
            sourceId = identifier,
            sourceUrl,
            eventOrder
        }, cancellationToken);

        logger?.LogInformation("Cleaning up temporary website document blobs");
        await inputBlob.DeleteIfExistsAsync(Azure.Storage.Blobs.Models.DeleteSnapshotsOption.IncludeSnapshots, cancellationToken: cancellationToken);
        if (renderedPath is not null)
            await blobs.GetBlobContainerClient("input").GetBlobClient(renderedPath)
                .DeleteIfExistsAsync(Azure.Storage.Blobs.Models.DeleteSnapshotsOption.IncludeSnapshots, cancellationToken: cancellationToken);
        if (extractionPath is not null)
            await blobs.GetBlobContainerClient(resultContainer).GetBlobClient(extractionPath)
                .DeleteIfExistsAsync(cancellationToken: cancellationToken);
        if (!string.Equals(resultContainer, "input", StringComparison.Ordinal) ||
            !string.Equals(resultPath, rawBlobName, StringComparison.Ordinal))
        {
            await blobs.GetBlobContainerClient(resultContainer).GetBlobClient(resultPath)
                .DeleteIfExistsAsync(cancellationToken: cancellationToken);
        }
    }

    public static bool TryCreateSourceUri(string? sourceUrl, out Uri? sourceUri)
    {
        if (Uri.TryCreate(sourceUrl, UriKind.Absolute, out var candidate) &&
            (candidate.Scheme == Uri.UriSchemeHttp || candidate.Scheme == Uri.UriSchemeHttps) &&
            !string.IsNullOrWhiteSpace(candidate.Host) &&
            string.IsNullOrEmpty(candidate.UserInfo))
        {
            sourceUri = candidate;
            return true;
        }

        sourceUri = null;
        return false;
    }

    private static string RequiredString(JsonElement content, string name)
    {
        if (!content.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(value.GetString()))
            throw new InvalidDataException($"Website ingestion requires {name}");
        return value.GetString()!;
    }

    private static bool BooleanValue(JsonElement content, string name)
    {
        if (!content.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null)
            return false;
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => throw new InvalidDataException($"Website ingestion {name} must be a boolean")
        };
    }

    private static string GetFilename(Uri sourceUri)
    {
        var filename = Uri.UnescapeDataString(Path.GetFileName(sourceUri.AbsolutePath));
        return string.IsNullOrWhiteSpace(filename) ? "Unknown" : filename;
    }
}
