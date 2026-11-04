using System;
using System.Text.Json.Serialization;

namespace DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Analytics
{
	public record DocumentIntelligenceResult(
		ResultStatus Status,
		DateTimeOffset CreatedDateTime,
		DateTimeOffset LastUpdatedDateTime,
		AnalyticalResult AnalyzeResult
	);
}
