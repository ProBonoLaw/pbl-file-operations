using System;
using System.Collections.Generic;
using System.Runtime.Serialization;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Exclusion;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models
{
	public record DocumentRequest(
		string Filename,
		string FilePath,
		string SourceId,
		string AccountId,
		string? ContainerName = null,
		string? ContainerPath = null,
		DateTimeOffset? ModifiedDate = null,
		DocumentIntelligenceResult? DocumentIntelligenceResult = null,
		ExclusionZones? ExclusionZones = null,
		bool? Force = false,
		bool? HighRes = false,
		Dictionary<string, string>? SpeakerNames = null,
		ResultMetadata? Metadata = null,
		string? SpeakerAnalysisId = null,
		SourceRendition? Rendition = null,
		string? JobId = null
	);

	public record ResultMetadata(
		string? Date = null,
		string? Location = null,
		string? Description = null);

	public record DocumentResponse(string ContainerName, string ContainerPath,
		string? ExtractionContainerPath = null, string? AnalysisId = null);

	public sealed record SourceRendition(string OriginalFilename, string OriginalSha256,
		string PdfSha256, string Renderer, string RendererVersion,
		string? ContainerName = null, string? ContainerPath = null);

	public record DocumentConversionRequest(string MarkdownFileContent, DocumentType DocumentType);

	public record DocumentConversionResponse(string Base64FileContent);

	public enum DocumentType
	{
		[EnumMember(Value = "HTML")]
		HTML,

		[EnumMember(Value = "DOCX")]
		DOCX,

		[EnumMember(Value = "PDF")]
		PDF,
	}
}
