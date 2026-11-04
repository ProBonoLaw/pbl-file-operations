using System.Text.Json;
using FileOperations;
using Xunit;

namespace FileOperations.Tests;

public class EvidenceExtractionOptionsTests
{
    [Theory]
    [InlineData("auto")]
    [InlineData("fast")]
    [InlineData("thorough")]
    public void PreservesModeThroughGatewaySerializationAndBrokerParsing(string mode)
    {
        var request = new IngestionRequest("account", "file", false, null, null, mode);
        var content = JsonSerializer.SerializeToElement(request, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(mode, EvidenceExtractionOptions.FromContent(content));
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"evidenceExtractionMode\":null}")]
    public void KeepsLegacyRequestsAutomatic(string json)
        => Assert.Null(EvidenceExtractionOptions.FromContent(JsonDocument.Parse(json).RootElement));

    [Theory]
    [InlineData("{\"evidenceExtractionMode\":\"quick\"}")]
    [InlineData("{\"evidenceExtractionMode\":[\"fast\"]}")]
    [InlineData("{\"evidenceExtractionMode\":true}")]
    public void RejectsMalformedBrokerOptions(string json)
        => Assert.Throws<InvalidDataException>(() => EvidenceExtractionOptions.FromContent(JsonDocument.Parse(json).RootElement));

    [Fact]
    public void PreservesBudgetOverrideThroughGatewaySerialization()
    {
        var request = new IngestionRequest("account", "file", false, null, null, "thorough", true);
        var content = JsonSerializer.SerializeToElement(request, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.True(EvidenceExtractionOptions.BudgetOverrideFromContent(content));
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"evidenceBudgetOverride\":null}")]
    public void LeavesLegacyBudgetOverrideUnset(string json)
        => Assert.Null(EvidenceExtractionOptions.BudgetOverrideFromContent(JsonDocument.Parse(json).RootElement));

    [Theory]
    [InlineData("{\"evidenceBudgetOverride\":\"true\"}")]
    [InlineData("{\"evidenceBudgetOverride\":1}")]
    public void RejectsMalformedBudgetOverride(string json)
        => Assert.Throws<InvalidDataException>(() => EvidenceExtractionOptions.BudgetOverrideFromContent(JsonDocument.Parse(json).RootElement));
}
