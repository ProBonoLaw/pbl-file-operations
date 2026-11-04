using System.IO;
using Azure;
using Azure.Storage.Blobs;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.Exclusion;
using DaatPhoenix.DataIntegrity.AI.DataIntegrity.Exceptions;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration.Helpers;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration.Telemetry;
using Microsoft.Extensions.Logging;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

public sealed class DataIntegrityTransformer(
    BlobServiceClient blobs,
    DataIntegrityOptions options,
    DocumentIntelligenceResultActivity documentIntelligence,
    NormalizerActivity normalizer,
    VideoIndexerClient videoIndexer,
    ContentUnderstandingActivity contentUnderstanding,
    ExtractionPolicy extractionPolicy,
    ILogger<DataIntegrityTransformer> logger)
{
    private static readonly TimeSpan VideoPollInterval = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan VideoIndexingTimeout = TimeSpan.FromHours(6);

    public async Task<DocumentResponse> TransformAsync(
        DocumentRequest request,
        CancellationToken cancellationToken)
    {
        var outputContainer = options.OutputContainer;
        using IDisposable telemetryScope = DataIntegrityTelemetryContext.Begin(
            logger, request.AccountId, request.SourceId);
        try
        {
            var route = await extractionPolicy.RouteAsync(request, blobs, cancellationToken);
            if (route.PreserveDocumentPages)
                logger.LogInformation("Routing {PageCount}-page PDF through Document Intelligence for page-aware extraction.",
                    route.PageCount);
            if (route.Provider == ExtractionPolicy.CuProvider)
                return await contentUnderstanding.RunAsync(request, cancellationToken);
            string? mediaType = ExtractionPolicy.MediaType(request.Filename, request.FilePath);
            if (mediaType is not null)
            {
                if (string.IsNullOrWhiteSpace(request.ContainerName) ||
                    string.IsNullOrWhiteSpace(request.ContainerPath))
                {
                    throw new ArgumentException($"An {mediaType} request must provide a blob container and path.");
                }

                var videoInput = new VideoIndexerInput(
                    request.ContainerName,
                    request.ContainerPath,
                    string.IsNullOrWhiteSpace(request.Filename)
                        ? Path.GetFileName(request.FilePath)
                        : request.Filename,
                    request.SourceId,
                    request.AccountId,
                    mediaType,
                    request.SpeakerNames,
                    request.HighRes ?? false,
                    request.Metadata);

                logger.LogInformation(
                    "Submitting {MediaType} {FileName} to Azure AI Video Indexer with {IndexingPreset} indexing.",
                    mediaType,
                    videoInput.Filename,
                    videoInput.HighRes ? "Advanced" : "configured baseline");
                var job = await videoIndexer.SubmitAsync(videoInput, cancellationToken);
                DateTimeOffset deadline = DateTimeOffset.UtcNow.Add(VideoIndexingTimeout);
                while (true)
                {
                    var pollInput = new VideoIndexerPollInput(
                        videoInput,
                        job.VideoId,
                        request.Filename,
                        request.FilePath,
                        request.ModifiedDate,
                        request.Force);
                    var result = await videoIndexer.GetIndexAsync(pollInput, cancellationToken);
                    logger.LogInformation("Video Indexer job {VideoId} is {State}.", job.VideoId, result.State);
                    if (string.Equals(result.State, "Processed", StringComparison.OrdinalIgnoreCase) &&
                        result.Markdown is not null)
                    {
                        string markdownPath = await ResultsMarkdownStorage.StoreAsync(
                            blobs, outputContainer, result.Markdown, request, cancellationToken);
                        return new DocumentResponse(outputContainer, markdownPath);
                    }
                    if (string.Equals(result.State, "Failed", StringComparison.OrdinalIgnoreCase))
                    {
                        throw new UnprocessableDocumentException(
                            $"Azure AI Video Indexer failed to index the {mediaType}.");
                    }
                    if (DateTimeOffset.UtcNow >= deadline)
                    {
                        throw new UnprocessableDocumentException(
                            "Timed out while waiting for Azure AI Video Indexer.");
                    }
                    await Task.Delay(VideoPollInterval, cancellationToken);
                }
            }

            var documentIntelligenceResult = request.DocumentIntelligenceResult;
            var hasExclusionZones = ExclusionZones.hasExclusionZones(request.ExclusionZones);
            if (documentIntelligenceResult is null)
            {
                if (string.IsNullOrWhiteSpace(request.ContainerName) ||
                    string.IsNullOrWhiteSpace(request.ContainerPath))
                {
                    throw new ArgumentException(
                        "Neither documentIntelligenceResult nor fileContent was provided!");
                }

                var analysis = await documentIntelligence.RunAsync(
                    new DocumentIntelligenceInput(
                        request.ContainerName,
                        request.ContainerPath,
                        hasExclusionZones,
                        request.HighRes ?? false,
                        request.AccountId,
                        request.SourceId,
                        request.Filename,
                        route.PreserveDocumentPages,
                        route.PageCount,
                        route.NormalizeEncryptedPdf),
                    cancellationToken);
                if (!hasExclusionZones && !analysis.RequiresFurtherAnalysis)
                {
                    if (analysis.Content is null)
                    {
                        throw new UnprocessableDocumentException(
                            "Document did not contain content that was processable.");
                    }

                    string markdownPath = await ResultsMarkdownStorage.StoreAsync(
                        blobs, outputContainer, analysis.Content, request, cancellationToken, route.CacheIdentity);
                    return new DocumentResponse(outputContainer, markdownPath);
                }
                documentIntelligenceResult = analysis.DocumentIntelligenceResult;
            }

            if (!hasExclusionZones)
            {
                if (documentIntelligenceResult?.AnalyzeResult?.Content is not { } content)
                {
                    throw new UnprocessableDocumentException(
                        "Document did not contain content that was processable.");
                }

                string markdownPath = await ResultsMarkdownStorage.StoreAsync(
                    blobs, outputContainer, content, request, cancellationToken, route.CacheIdentity);
                return new DocumentResponse(outputContainer, markdownPath);
            }

            if (documentIntelligenceResult is null)
            {
                throw new UnprocessableDocumentException("Document did not contain content that was parsable.");
            }

            string normalized = normalizer.Run(
                new NormalizationRequest(documentIntelligenceResult, request));
            string normalizedPath = await ResultsMarkdownStorage.StoreAsync(
                blobs, outputContainer, normalized, request, cancellationToken, route.CacheIdentity);
            return new DocumentResponse(outputContainer, normalizedPath);
        }
        catch (UnprocessableDocumentException exception)
        {
            logger.LogError(exception, "Document could not be processed");
            throw new UnprocessableDocumentException(
                "Unable to process your request due to the data not being formatted correctly.", exception);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (FileNotFoundException)
        {
            throw;
        }
        catch (ArgumentException)
        {
            throw;
        }
        catch (RequestFailedException exception)
        {
            logger.LogError(exception, "Azure service request failed during document transformation");
            throw;
        }
        catch (InvalidDataException exception)
        {
            logger.LogError(exception, "Document input could not be processed");
            throw new UnprocessableDocumentException(
                "Unable to process your request due to the data not being formatted correctly.", exception);
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "Unexpected error while transforming document");
            throw;
        }
    }

}
