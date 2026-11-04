using System.Text.Json;

namespace FileOperations;

public static class EvidenceExtractionOptions
{
    // Validate broker inputs as well as the public HTTP request, before doing ingestion work.
    public static string? FromContent(JsonElement content)
    {
        if (!content.TryGetProperty("evidenceExtractionMode", out var value) || value.ValueKind == JsonValueKind.Null)
            return null;
        if (value.ValueKind == JsonValueKind.String && value.GetString() is "auto" or "fast" or "thorough")
            return value.GetString();
        throw new InvalidDataException("evidenceExtractionMode must be auto, fast, or thorough");
    }

    public static bool? BudgetOverrideFromContent(JsonElement content)
    {
        if (!content.TryGetProperty("evidenceBudgetOverride", out var value) || value.ValueKind == JsonValueKind.Null)
            return null;
        if (value.ValueKind is JsonValueKind.True or JsonValueKind.False)
            return value.GetBoolean();
        throw new InvalidDataException("evidenceBudgetOverride must be a boolean");
    }
}
