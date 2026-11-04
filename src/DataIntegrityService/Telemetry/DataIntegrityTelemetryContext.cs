using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using Microsoft.Extensions.Logging;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration.Telemetry
{
	/// <summary>
	/// Holds document identity for the lifetime of one function invocation. AsyncLocal
	/// prevents concurrent durable instances from sharing telemetry dimensions.
	/// </summary>
	internal static class DataIntegrityTelemetryContext
	{
		internal const string AccountIdPropertyName = "accountId";
		internal const string SourceIdPropertyName = "sourceId";

		private const string AccountIdActivityTag = "dataIntegrity.accountId";
		private const string SourceIdActivityTag = "dataIntegrity.sourceId";
		private static readonly AsyncLocal<Dimensions?> CurrentDimensions = new();

		public static IDisposable Begin(string? accountId, string? sourceId)
		{
			Dimensions? previous = CurrentDimensions.Value;
			Dimensions dimensions = new(accountId ?? string.Empty, sourceId ?? string.Empty);
			CurrentDimensions.Value = dimensions;
			Stamp(Activity.Current, dimensions);
			return new Scope(previous);
		}

		public static IDisposable Begin(ILogger logger, string? accountId, string? sourceId)
		{
			IDisposable contextScope = Begin(accountId, sourceId);
			IDisposable? loggerScope = logger.BeginScope(new Dictionary<string, object?>
			{
				[AccountIdPropertyName] = accountId ?? string.Empty,
				[SourceIdPropertyName] = sourceId ?? string.Empty,
			});
			return new CombinedScope(contextScope, loggerScope);
		}

		public static bool TryGet(out Dimensions dimensions)
		{
			if (CurrentDimensions.Value is { } current)
			{
				dimensions = current;
				return true;
			}

			for (Activity? activity = Activity.Current; activity is not null; activity = activity.Parent)
			{
				if (activity.GetTagItem(AccountIdActivityTag) is string accountId
					&& activity.GetTagItem(SourceIdActivityTag) is string sourceId)
				{
					dimensions = new Dimensions(accountId, sourceId);
					return true;
				}
			}

			dimensions = default;
			return false;
		}

		private static void Stamp(Activity? activity, Dimensions dimensions)
		{
			activity?.SetTag(AccountIdActivityTag, dimensions.AccountId);
			activity?.SetTag(SourceIdActivityTag, dimensions.SourceId);
		}

		internal readonly record struct Dimensions(string AccountId, string SourceId);

		private sealed class Scope(Dimensions? previous) : IDisposable
		{
			public void Dispose() => CurrentDimensions.Value = previous;
		}

		private sealed class CombinedScope(IDisposable contextScope, IDisposable? loggerScope) : IDisposable
		{
			public void Dispose()
			{
				loggerScope?.Dispose();
				contextScope.Dispose();
			}
		}
	}
}
