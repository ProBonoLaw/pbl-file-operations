using System.Text.Json;
using System.Threading.Tasks;
using DaatPhoenix.DaatLaw.AI.DataIntegrity;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Exclusion;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration.Telemetry;
using Microsoft.Extensions.Logging;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration
{
	public class NormalizerActivity
	{
		private readonly ILogger<NormalizerActivity> logger;

		public NormalizerActivity(ILogger<NormalizerActivity> logger)
		{
			this.logger = logger;
		}
		public string Run(NormalizationRequest input)
		{
			using var telemetryScope = DataIntegrityTelemetryContext.Begin(logger, input.OriginalRequest.AccountId, input.OriginalRequest.SourceId);
			logger.LogInformation("Proceeding to normalization of file content.");
			var request = input.OriginalRequest;
			var documentIntelligenceResult = input.DocumentIntelligenceResult;
			Normalizer normalizer =
				new(documentIntelligenceResult, request.Filename, request.FilePath);
			ExclusionZones? exclusionZones = request.ExclusionZones;
			logger.LogInformation(
				"Exclusion Zone included: "
					+ JsonSerializer.Serialize(
						exclusionZones,
						new JsonSerializerOptions { IncludeFields = true }
					)
			);
			normalizer.AddExclusionZone(exclusionZones);
			normalizer.Close();
			return normalizer.ToString();
		}
	}
}
