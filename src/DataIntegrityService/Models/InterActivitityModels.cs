
using System;
using System.Collections.Generic;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models
{
	public record NeedAnalysis(
		bool RequiresFurtherAnalysis,
		DocumentIntelligenceResult? DocumentIntelligenceResult = null,
		string? Content = null
	);

	public record DocumentIntelligenceInput(
		string Container,
		string FilePath,
		bool HasExclusionZones,
		bool HighRes = false,
		string AccountId = "",
		string SourceId = "",
		string? Filename = null,
		bool PreserveDocumentPages = false,
		int? ExpectedPageCount = null,
		bool NormalizeEncryptedPdf = false
	);

	/// <summary>
	/// Identifies a video stored in the ingestion Blob account. The Blob location is
	/// intentionally processing-only metadata and is never emitted in Markdown.
	/// </summary>
	public record VideoIndexerInput(
		string Container,
		string FilePath,
		string Filename,
		string SourceId,
		string AccountId,
		string MediaType = "video",
		Dictionary<string, string>? SpeakerNames = null,
		bool HighRes = false,
		ResultMetadata? Metadata = null
	);

	public record VideoIndexerJob(string VideoId);

	public record VideoIndexerPollInput(
		VideoIndexerInput Source,
		string VideoId,
		string OutputFilename,
		string OutputFilePath,
		DateTimeOffset? ModifiedDate = null,
		bool? Force = false);

	internal record VideoIndexerIndexResult(string State, string? Markdown = null);

	public record NormalizationRequest(
		DocumentIntelligenceResult DocumentIntelligenceResult,
		DocumentRequest OriginalRequest
	);
}
