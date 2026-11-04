using System.Text.Json;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;

/// <summary>Versioned, provider-neutral ingestion contract. Generated blocks are never quotation sources.</summary>
public sealed record ExtractionPackage(
    int Version, string AccountId, string SourceId, string MediaType, string Provider, string AnalyzerId, string ApiVersion,
    string AnalysisId, string ConfigurationHash, string SourceSha256, string StringEncoding,
    string LiteralMarkdown, IReadOnlyList<LiteralPage> LiteralPages,
    IReadOnlyList<ExtractionBlock> Blocks, IReadOnlyList<EvidenceLocation> EvidenceLocations,
    JsonElement RawResponse, JsonElement? Usage, IReadOnlyList<JsonElement> Warnings,
    SourceRendition? Rendition = null, ResultMetadata? SourceMetadata = null,
    IReadOnlyList<ExtractionAsset>? Assets = null, int? MarkdownCoverageVersion = null);

public sealed record LiteralPage(int PageNumber, string Text, string LocationKind);
public sealed record ServiceSpan(int ContentIndex, int Offset, int Length);
public sealed record ExtractionBlock(
    string Id, string Kind, string Origin, string Text, IReadOnlyList<int> Pages,
    IReadOnlyList<string> Regions, IReadOnlyList<ServiceSpan> ServiceSpans,
    long? StartTimeMs = null, long? EndTimeMs = null, string? Speaker = null,
    IReadOnlyList<long>? KeyFrameTimesMs = null);
public sealed record EvidenceLocation(
    int PageNumber, int Offset, int Length, string BlockId, IReadOnlyList<int> Pages,
    IReadOnlyList<string> Regions, long? StartTimeMs = null, long? EndTimeMs = null,
    string? Speaker = null);

public sealed record ExtractionAsset(string Id, string Kind, string ContainerName,
    string ContainerPath, string ContentType, string Sha256, long SizeBytes,
    string ServiceFilePath, IReadOnlyList<string> BlockIds, IReadOnlyList<int> Pages,
    IReadOnlyList<string> Regions, string Url, long? TimeMs = null);
