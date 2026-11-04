using System.Text.Json;

namespace FileOperations;

internal sealed record MediaFeedback(bool Exists, object? SpeakerNames, object? Metadata, string? AnalysisId);

internal static class MediaFeedbackExtraction
{
    public static async Task<(JsonElement? Response, bool FeedbackExists)> ResolveAsync(
        HttpFunctions functions, Dictionary<string, object?> input, bool cuSelected,
        MediaFeedback feedback, CancellationToken cancellationToken)
    {
        if (!cuSelected)
        {
            if (feedback.Exists && feedback.SpeakerNames is not null) input["speakerNames"] = feedback.SpeakerNames;
            if (feedback.Metadata is not null) input["metadata"] = feedback.Metadata;
            if (feedback.AnalysisId is not null) input["speakerAnalysisId"] = feedback.AnalysisId;
            var cached = await functions.FindMarkdownAsync(input, cancellationToken);
            return (cached ?? await functions.TransformMarkdownAsync(input, cancellationToken), feedback.Exists);
        }

        // Transform without names to resolve the operation for these source bytes and CU settings.
        // The CU journal reuses paid work; a Markdown cache hit alone cannot establish this identity.
        input.Remove("speakerNames");
        input.Remove("speakerAnalysisId");
        var current = await functions.TransformMarkdownAsync(input, cancellationToken);
        var (packagePath, analysisId) = IngestionFlow.ExtractionLocation(current);
        if (string.IsNullOrWhiteSpace(packagePath) || string.IsNullOrWhiteSpace(analysisId))
            throw new InvalidDataException("CU media extraction must return its package and current analysis ID.");

        // Persist the current ID in fresh feedback input, never the stale row's ID.
        input["speakerAnalysisId"] = analysisId;
        var reusable = feedback.Exists && !string.IsNullOrWhiteSpace(feedback.AnalysisId) &&
            string.Equals(feedback.AnalysisId, analysisId, StringComparison.Ordinal);
        if (!reusable) return (current, false);

        if (feedback.SpeakerNames is not null) input["speakerNames"] = feedback.SpeakerNames;
        if (feedback.Metadata is not null) input["metadata"] = feedback.Metadata;
        if (feedback.SpeakerNames is null && feedback.Metadata is null) return (current, true);

        // Adapt matching feedback from the same saved operation without another CU analysis POST.
        var named = await functions.FindMarkdownAsync(input, cancellationToken) ??
            await functions.TransformMarkdownAsync(input, cancellationToken);
        var (namedPackage, namedAnalysis) = IngestionFlow.ExtractionLocation(named);
        if (string.IsNullOrWhiteSpace(namedPackage) || !string.Equals(namedAnalysis, analysisId, StringComparison.Ordinal))
            throw new InvalidDataException("Speaker feedback extraction differs from the resolved CU analysis.");
        return (named, true);
    }
}
