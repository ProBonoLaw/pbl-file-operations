using Microsoft.ApplicationInsights.Channel;
using Microsoft.ApplicationInsights.DataContracts;
using Microsoft.ApplicationInsights.Extensibility;

namespace FileOperations;

public sealed class RoleNameTelemetryInitializer(string role) : ITelemetryInitializer
{
    public void Initialize(ITelemetry telemetry) =>
        telemetry.Context.Cloud.RoleName = $"file-operations-{role}";
}

public sealed class DependencyUrlTelemetryProcessor(ITelemetryProcessor next) : ITelemetryProcessor
{
    private static readonly HashSet<string> HttpMethods =
        ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

    public void Process(ITelemetry telemetry)
    {
        if (telemetry is DependencyTelemetry dependency)
        {
            var method = dependency.Name?.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries)
                .FirstOrDefault()?.ToUpperInvariant();
            dependency.Name = method is not null && HttpMethods.Contains(method)
                ? $"{method} HTTP"
                : dependency.Type ?? "Dependency";
            dependency.Data = string.Empty;
        }
        else if (telemetry is RequestTelemetry request && request.Url is { } url &&
                 (!string.IsNullOrEmpty(url.Query) || !string.IsNullOrEmpty(url.Fragment)))
        {
            request.Url = new UriBuilder(url) { Query = string.Empty, Fragment = string.Empty }.Uri;
        }

        next.Process(telemetry);
    }
}

public sealed class DependencyUrlTelemetryProcessorFactory :
    Microsoft.ApplicationInsights.AspNetCore.ITelemetryProcessorFactory,
    Microsoft.ApplicationInsights.WorkerService.ITelemetryProcessorFactory
{
    public ITelemetryProcessor Create(ITelemetryProcessor next) =>
        new DependencyUrlTelemetryProcessor(next);
}
