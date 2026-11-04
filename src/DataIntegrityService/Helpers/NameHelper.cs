using System.IO;
using System.Text;
using System.Security.Cryptography;
using System.Text.Json;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Exclusion;
using System.Collections.Generic;
using System.Linq;
using System;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration.Helpers
{
	public static class NameHelper
	{
		// Clipper2 PointD coordinates are public fields and must be included in cache identity.
		private static readonly JsonSerializerOptions ExclusionZonesJsonOptions = new()
		{
			IncludeFields = true,
		};

		public static string GenerateTempFileName(DocumentRequest request, string extractionIdentity = "")
		{
			string speakerNames = request.SpeakerNames is null || request.SpeakerNames.Count == 0
				? string.Empty
				: $"_{string.Join("\u001e", request.SpeakerNames
					.OrderBy(item => item.Key, StringComparer.Ordinal)
					.Select(item => $"{item.Key}\u001f{item.Value}"))}";
			string metadata = request.Metadata is null
				? string.Empty
				: $"_{request.Metadata.Date}\u001f{request.Metadata.Location}\u001f{request.Metadata.Description}";
			string exclusionZones = request.ExclusionZones is null
				? string.Empty
				: $"_{GenerateExclusionZonesHash(request.ExclusionZones)}";
			var rawFilename =
				$"{request.SourceId}_{request.AccountId}_{request.FilePath}_{request.Filename}_{request.ModifiedDate ?? DateTimeOffset.MinValue}_{request.HighRes}{speakerNames}{metadata}{exclusionZones}.md";
			if (extractionIdentity.Length != 0) rawFilename += $"|{extractionIdentity}|{request.SpeakerAnalysisId}";
			if (request.Rendition is not null) rawFilename += "|" + JsonSerializer.Serialize(request.Rendition);

			// Remove invalid characters
			var invalidChars = new HashSet<char>(Path.GetInvalidFileNameChars());
			rawFilename = new string([.. rawFilename.Where(c => !invalidChars.Contains(c))]);

			using (SHA256 sha256Hash = SHA256.Create())
			{
				// ComputeHash - returns byte array
				byte[] bytes = sha256Hash.ComputeHash(Encoding.UTF8.GetBytes(rawFilename));

				// Convert byte array to a string
				StringBuilder builder = new StringBuilder();
				for (int i = 0; i < bytes.Length; i++)
				{
					builder.Append(bytes[i].ToString("x2"));
				}
				return builder.ToString();
			}
		}

		private static string GenerateExclusionZonesHash(ExclusionZones exclusionZones)
		{
			string serializedExclusionZones = JsonSerializer.Serialize(
				exclusionZones,
				ExclusionZonesJsonOptions
			);
			byte[] bytes = SHA256.HashData(Encoding.UTF8.GetBytes(serializedExclusionZones));
			return Convert.ToHexString(bytes).ToLowerInvariant();
		}
	}
}
