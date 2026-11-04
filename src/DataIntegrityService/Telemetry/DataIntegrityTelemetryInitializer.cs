using Microsoft.ApplicationInsights.Channel;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.ApplicationInsights.Extensibility;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration.Telemetry
{
	/// <summary>
	/// Adds the document identity to telemetry created by the worker SDK, including
	/// traces, exceptions, events, and dependency telemetry.
	/// </summary>
	internal sealed class DataIntegrityTelemetryInitializer : ITelemetryInitializer
	{
		public void Initialize(ITelemetry telemetry)
		{
			if (telemetry is not ISupportProperties telemetryWithProperties
				|| !DataIntegrityTelemetryContext.TryGet(out DataIntegrityTelemetryContext.Dimensions dimensions))
			{
				return;
			}

			if (!telemetryWithProperties.Properties.ContainsKey(DataIntegrityTelemetryContext.AccountIdPropertyName))
			{
				telemetryWithProperties.Properties[DataIntegrityTelemetryContext.AccountIdPropertyName] = dimensions.AccountId;
			}
			if (!telemetryWithProperties.Properties.ContainsKey(DataIntegrityTelemetryContext.SourceIdPropertyName))
			{
				telemetryWithProperties.Properties[DataIntegrityTelemetryContext.SourceIdPropertyName] = dimensions.SourceId;
			}
		}
	}
}
