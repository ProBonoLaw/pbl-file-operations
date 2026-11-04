using System.Security.Cryptography;
using System.Text;
using Azure.Storage.Blobs;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Exclusion;
using Microsoft.Extensions.Configuration;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

public sealed record ExtractionRoute(string Provider, string CacheIdentity = "", bool PreserveDocumentPages = false,
    int? PageCount = null, bool NormalizeEncryptedPdf = false);

public sealed class ExtractionPolicy(IConfiguration configuration)
{
    public const string CuProvider = "content-understanding";
    public const string DocumentIntelligenceProvider = "document-intelligence";
    public const int CuMaximumDocumentPages = 300;
    public const int DocumentIntelligenceMaximumPdfPages = 2_000;
    public const string PagedDocumentIntelligenceIdentity = "document-intelligence-paged-v2";

    public static string Extension(string? filename, string? fallback = null)
    {
        var extension = Path.GetExtension(filename ?? "");
        return (extension.Length == 0 ? Path.GetExtension(fallback ?? "") : extension).ToLowerInvariant();
    }

    public static string? MediaType(string? filename, string? fallback = null) =>
        MediaTypeForExtension(MediaExtension(filename, fallback));

    public static string? MediaExtension(string? filename, string? fallback = null)
    {
        // Preserve the first recognized media name, even if another name has a document extension.
        var extension = Path.GetExtension(filename ?? "").ToLowerInvariant();
        if (MediaTypeForExtension(extension) is not null) return extension;
        extension = Path.GetExtension(fallback ?? "").ToLowerInvariant();
        return MediaTypeForExtension(extension) is not null ? extension : null;
    }

    private static string? MediaTypeForExtension(string? extension) => extension switch
    {
        ".mp4" or ".mov" or ".m4v" or ".avi" or ".mkv" or ".wmv" or ".webm" or ".flv" or ".asf" => "video",
        ".aac" or ".aiff" or ".amr" or ".flac" or ".m4a" or ".mp3" or ".ogg" or ".opus" or ".wav" or ".wma" => "audio",
        _ => null
    };

    public string Provider(DocumentRequest request)
    {
        var media = MediaType(request.Filename, request.FilePath);
        var baseline = media is null ? "document-intelligence" : "video-indexer";
        var setting = $"INTEGRITY_{(media ?? "document").ToUpperInvariant()}_PROVIDER";
        var selected = configuration[setting] ?? baseline;
        if (selected != baseline && selected != CuProvider)
            throw new InvalidOperationException($"{setting} must be {baseline} or {CuProvider}.");
        // CSV is already structured text; the legacy route reads it locally without an OCR call.
        if (media is null && Extension(request.Filename, request.FilePath) == ".csv") return "document-intelligence";
        // Positional exclusions and the legacy high-resolution option keep their existing semantics.
        if (media is null && (request.DocumentIntelligenceResult is not null ||
            ExclusionZones.hasExclusionZones(request.ExclusionZones) || request.HighRes == true)) return baseline;
        // These formats are accepted by the existing pipeline but not CU's documented media formats.
        if (MediaExtension(request.Filename, request.FilePath) is ".webm" or ".aiff" or ".amr") return baseline;
        return selected;
    }

    public string CacheIdentity(DocumentRequest request)
    {
        if (Provider(request) != CuProvider) return "";
        var options = ContentUnderstandingOptions.Read(configuration);
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"extraction-v1|{options.Endpoint}|{options.Analyzer(MediaType(request.Filename, request.FilePath) ?? "document")}|" +
            $"{ContentUnderstandingOptions.ApiVersion}|{options.ProcessingLocation}|{options.ConfigurationVersion}|{options.ModelDeployments}")));
    }

    public async Task<ExtractionRoute> RouteAsync(DocumentRequest request, BlobServiceClient blobs,
        CancellationToken cancellationToken)
    {
        string provider = Provider(request);
        if (MediaType(request.Filename, request.FilePath) is not null ||
            (request.Rendition is null && Extension(request.Filename, request.FilePath) != ".pdf"))
            return new(provider, provider == CuProvider ? CacheIdentity(request) : "");
        if (string.IsNullOrWhiteSpace(request.ContainerName) || string.IsNullOrWhiteSpace(request.ContainerPath))
            return new(provider, provider == CuProvider ? CacheIdentity(request) : "");
        var inspection = await PdfPageCounter.InspectAsync(blobs.GetBlobContainerClient(request.ContainerName)
            .GetBlobClient(request.ContainerPath), cancellationToken);
        return RouteForPdfPages(request, inspection.Pages, inspection.Encrypted);
    }

    public ExtractionRoute RouteForPdfPages(DocumentRequest request, int pages, bool encrypted = false)
    {
        if (pages < 1) throw new ArgumentOutOfRangeException(nameof(pages));
        if (pages > DocumentIntelligenceMaximumPdfPages)
            throw new InvalidDataException("PDF exceeds Document Intelligence's 2,000-page limit.");
        string provider = Provider(request);
        if (provider is not (CuProvider or DocumentIntelligenceProvider)) return new(provider);
        string setting = configuration["CONTENT_UNDERSTANDING_MAX_DOCUMENT_PAGES"] ??
            CuMaximumDocumentPages.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (!int.TryParse(setting, out int maximum) || maximum < 1 || maximum > CuMaximumDocumentPages)
            throw new InvalidOperationException("CONTENT_UNDERSTANDING_MAX_DOCUMENT_PAGES must be between 1 and 300.");
        if (pages > maximum || encrypted)
            return new(DocumentIntelligenceProvider, PagedDocumentIntelligenceIdentity, true, pages, encrypted);
        return new(provider, provider == CuProvider ? CacheIdentity(request) : "", false, pages);
    }
}

public sealed record ContentUnderstandingOptions(
    Uri Endpoint, string? ApiKey, string DocumentAnalyzer, string AudioAnalyzer, string VideoAnalyzer,
    string ProcessingLocation, string ConfigurationVersion, string? ModelDeployments, TimeSpan Timeout)
{
    public const string ApiVersion = "2025-11-01";
    public string Analyzer(string media) => media switch
    {
        "document" => DocumentAnalyzer, "audio" => AudioAnalyzer, "video" => VideoAnalyzer,
        _ => throw new ArgumentException("Unknown media type.")
    };

    public static ContentUnderstandingOptions Read(IConfiguration configuration)
    {
        if (!Uri.TryCreate(configuration["CONTENT_UNDERSTANDING_ENDPOINT"], UriKind.Absolute, out var endpoint) ||
            endpoint.Scheme != "https" || endpoint.UserInfo.Length != 0 || endpoint.Query.Length != 0 ||
            endpoint.Fragment.Length != 0 || endpoint.AbsolutePath != "/")
            throw new InvalidOperationException("CONTENT_UNDERSTANDING_ENDPOINT must be a root HTTPS endpoint.");
        var location = configuration["CONTENT_UNDERSTANDING_PROCESSING_LOCATION"] ?? "geography";
        if (location is not ("geography" or "global" or "dataZone"))
            throw new InvalidOperationException("Invalid CONTENT_UNDERSTANDING_PROCESSING_LOCATION.");
        return new(endpoint, configuration["CONTENT_UNDERSTANDING_API_KEY"],
            configuration["CONTENT_UNDERSTANDING_DOCUMENT_ANALYZER"] ?? "prebuilt-documentSearch",
            configuration["CONTENT_UNDERSTANDING_AUDIO_ANALYZER"] ?? "prebuilt-audioSearch",
            configuration["CONTENT_UNDERSTANDING_VIDEO_ANALYZER"] ?? "prebuilt-videoSearch", location,
            configuration["CONTENT_UNDERSTANDING_CONFIGURATION_VERSION"] ?? "1",
            configuration["CONTENT_UNDERSTANDING_MODEL_DEPLOYMENTS"], TimeSpan.FromHours(6));
    }
}
