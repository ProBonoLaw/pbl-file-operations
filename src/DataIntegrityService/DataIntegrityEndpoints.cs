using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DataIntegrity.AI.DataIntegrity.Exceptions;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration.Telemetry;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

public static class DataIntegrityEndpoints
{
    public static IEndpointRouteBuilder MapDataIntegrityEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));
        endpoints.MapPost("/internal/data-integrity/lookup", async (
            DocumentRequest request,
            DataIntegrityFileLookup lookup,
            IIngestionStopStore stops,
            ILoggerFactory loggerFactory,
            CancellationToken cancellationToken) =>
        {
            if (!IsValid(request)) return Results.BadRequest("filename, filePath, accountId, and sourceId are required");
            var logger = loggerFactory.CreateLogger("DataIntegrityEndpoints");
            using var identityScope = DataIntegrityTelemetryContext.Begin(logger, request.AccountId, request.SourceId);
            if (request.JobId is not null &&
                await stops.IsStoppedAsync(request.AccountId, request.SourceId, request.JobId, cancellationToken))
                return Results.Conflict(new { error = "ingestion_job_stopped" });
            var result = await lookup.FindExistingAsync(request, cancellationToken);
            logger.LogInformation("Data Integrity cache lookup {CacheResult}", result is null ? "miss" : "hit");
            return result is null ? Results.NotFound() : Results.Ok(result);
        });
        endpoints.MapPost("/internal/data-integrity/transform", async (
            DocumentRequest request,
            DataIntegrityTransformer transformer,
            IIngestionStopStore stops,
            ILoggerFactory loggerFactory,
            CancellationToken cancellationToken) =>
        {
            if (!IsValid(request)) return Results.BadRequest("filename, filePath, accountId, and sourceId are required");
            var logger = loggerFactory.CreateLogger("DataIntegrityEndpoints");
            using var identityScope = DataIntegrityTelemetryContext.Begin(logger, request.AccountId, request.SourceId);
            logger.LogInformation("Data Integrity transformation requested");
            try
            {
                if (request.JobId is null) return Results.Ok(await transformer.TransformAsync(request, cancellationToken));
                DocumentResponse? transformed = null;
                await stops.RunUntilStoppedAsync(request.AccountId, request.SourceId, request.JobId,
                    async token => { transformed = await transformer.TransformAsync(request, token); }, cancellationToken);
                return Results.Ok(transformed);
            }
            catch (OperationCanceledException)
            {
                if (request.JobId is null ||
                    !await stops.IsStoppedAsync(request.AccountId, request.SourceId, request.JobId, CancellationToken.None))
                    throw;
                logger.LogWarning("Data Integrity transformation stopped for job {JobId}", request.JobId);
                return Results.Conflict(new { error = "ingestion_job_stopped" });
            }
            catch (FileNotFoundException exception)
            {
                return Results.NotFound(new { error = exception.Message });
            }
            catch (ArgumentException exception)
            {
                return Results.BadRequest(new { error = exception.Message });
            }
            catch (TransientVideoIndexerException exception)
            {
                logger.LogWarning(exception, "Video Indexer request failed temporarily");
                return Results.Problem(
                    detail: exception.Message,
                    statusCode: (int)exception.StatusCode,
                    title: "Video Indexer temporarily unavailable");
            }
            catch (UnprocessableDocumentException exception)
            {
                logger.LogWarning(exception, "Document transformation could not be completed");
                return Results.UnprocessableEntity(new { error = exception.Message });
            }
        });
        return endpoints;
    }

    private static bool IsValid(DocumentRequest request) =>
        !string.IsNullOrWhiteSpace(request.Filename) &&
        !string.IsNullOrWhiteSpace(request.FilePath) &&
        !string.IsNullOrWhiteSpace(request.AccountId) &&
        !string.IsNullOrWhiteSpace(request.SourceId);
}
