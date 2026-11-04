using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace FileOperations.Tests;

public class ExtractionPolicyTests
{
    [Theory]
    [InlineData("display.pdf", "recording.mp4")]
    [InlineData("display.pdf", "recording.WAV")]
    [InlineData("display.csv", "recording.mp3")]
    [InlineData("display.docx", "folder/recording.mov")]
    [InlineData("display", "recording.wav")]
    [InlineData("", "recording.mp4")]
    public void MediaInEitherNameUsesLegacyMediaProviderByDefault(string filename, string path)
    {
        var policy = new ExtractionPolicy(Configuration());
        var request = Request(filename, path);

        Assert.Equal("video-indexer", policy.Provider(request));
        Assert.Equal("", policy.CacheIdentity(request));
    }

    [Theory]
    [InlineData("display.pdf", "recording.mp4", "video")]
    [InlineData("display.pdf", "folder/recording.WAV", "audio")]
    [InlineData("display.csv", "recording.mp4", "video")]
    [InlineData("display.csv", "recording.mp3", "audio")]
    [InlineData("display.docx", "recording.wav", "audio")]
    [InlineData("display.pptx", "recording.mov", "video")]
    [InlineData("display", "recording.wav", "audio")]
    public void PathMediaUsesItsConfiguredProviderAndAnalyzer(string filename, string path, string media)
    {
        var policy = new ExtractionPolicy(Configuration(new()
        {
            [$"INTEGRITY_{media.ToUpperInvariant()}_PROVIDER"] = ExtractionPolicy.CuProvider,
            ["CONTENT_UNDERSTANDING_ENDPOINT"] = "https://example.services.ai.azure.com/"
        }));
        var request = Request(filename, path) with { HighRes = true };

        Assert.Equal(media, ExtractionPolicy.MediaType(filename, path));
        Assert.Equal(ExtractionPolicy.CuProvider, policy.Provider(request));
        Assert.Equal(policy.CacheIdentity(request with { Filename = Path.GetFileName(path) }),
            policy.CacheIdentity(request));
    }

    [Theory]
    [InlineData("recording.MP4", "recording.wav", "video")]
    [InlineData("recording.wav", "recording.mp4", "audio")]
    [InlineData("recording.mp4", "recording.webm", "video")]
    public void PrimaryMediaNameTakesPrecedenceWhenBothNamesIdentifyMedia(string filename, string path, string media)
    {
        var policy = new ExtractionPolicy(Configuration(new()
        {
            [$"INTEGRITY_{media.ToUpperInvariant()}_PROVIDER"] = ExtractionPolicy.CuProvider
        }));

        Assert.Equal(media, ExtractionPolicy.MediaType(filename, path));
        Assert.Equal(ExtractionPolicy.CuProvider, policy.Provider(Request(filename, path)));
    }

    [Theory]
    [InlineData("recording.webm")]
    [InlineData("recording.AIFF")]
    [InlineData("folder/recording.amr")]
    public void UnsupportedCuMediaInPathRetainsLegacyProvider(string path)
    {
        var policy = new ExtractionPolicy(Configuration(new()
        {
            ["INTEGRITY_DOCUMENT_PROVIDER"] = ExtractionPolicy.CuProvider,
            ["INTEGRITY_AUDIO_PROVIDER"] = ExtractionPolicy.CuProvider,
            ["INTEGRITY_VIDEO_PROVIDER"] = ExtractionPolicy.CuProvider
        }));
        var request = Request("display.pdf", path);

        Assert.Equal("video-indexer", policy.Provider(request));
        Assert.Equal("", policy.CacheIdentity(request));
    }

    [Fact]
    public void PathMediaCacheDependsOnItsAnalyzer()
    {
        var configuration = Configuration(new()
        {
            ["INTEGRITY_AUDIO_PROVIDER"] = ExtractionPolicy.CuProvider,
            ["CONTENT_UNDERSTANDING_ENDPOINT"] = "https://example.services.ai.azure.com/"
        });
        var policy = new ExtractionPolicy(configuration);
        var request = Request("display.pdf", "recording.wav");
        var original = policy.CacheIdentity(request);
        Assert.NotEmpty(original);

        configuration["CONTENT_UNDERSTANDING_DOCUMENT_ANALYZER"] = "different-document";
        configuration["CONTENT_UNDERSTANDING_VIDEO_ANALYZER"] = "different-video";
        Assert.Equal(original, policy.CacheIdentity(request));
        configuration["CONTENT_UNDERSTANDING_AUDIO_ANALYZER"] = "different-audio";
        Assert.NotEqual(original, policy.CacheIdentity(request));
    }

    [Theory]
    [InlineData("display.pdf", "folder/source.pdf")]
    [InlineData("display.bin", "folder/source.bin")]
    [InlineData("display", "folder/source")]
    public void NonMediaNamesRemainDocuments(string filename, string path)
    {
        var policy = new ExtractionPolicy(Configuration());

        Assert.Null(ExtractionPolicy.MediaType(filename, path));
        Assert.Equal("document-intelligence", policy.Provider(Request(filename, path)));
    }

    [Fact]
    public void OversizedPdfRoutesToPageAwareDocumentIntelligenceWithoutCuCacheIdentity()
    {
        var policy = new ExtractionPolicy(Configuration(new()
        {
            ["INTEGRITY_DOCUMENT_PROVIDER"] = ExtractionPolicy.CuProvider,
            ["CONTENT_UNDERSTANDING_ENDPOINT"] = "https://example.services.ai.azure.com/"
        }));
        var request = Request("report.pdf", "report.pdf");
        var withinLimit = policy.RouteForPdfPages(request, 300);
        var oversized = policy.RouteForPdfPages(request, 301);

        Assert.Equal(ExtractionPolicy.CuProvider, withinLimit.Provider);
        Assert.NotEmpty(withinLimit.CacheIdentity);
        Assert.False(withinLimit.PreserveDocumentPages);
        Assert.Equal(ExtractionPolicy.DocumentIntelligenceProvider, oversized.Provider);
        Assert.Equal(ExtractionPolicy.PagedDocumentIntelligenceIdentity, oversized.CacheIdentity);
        Assert.True(oversized.PreserveDocumentPages);
        Assert.Equal(301, oversized.PageCount);
        var encrypted = policy.RouteForPdfPages(request, 3, encrypted: true);
        Assert.Equal(ExtractionPolicy.DocumentIntelligenceProvider, encrypted.Provider);
        Assert.True(encrypted.NormalizeEncryptedPdf);
        Assert.True(encrypted.PreserveDocumentPages);
        Assert.Throws<InvalidDataException>(() => policy.RouteForPdfPages(request, 2_001));
    }

    [Fact]
    public void PdfRouteThresholdCanBeLowerButNotHigherThanCuLimit()
    {
        var configuration = Configuration(new()
        {
            ["INTEGRITY_DOCUMENT_PROVIDER"] = ExtractionPolicy.CuProvider,
            ["CONTENT_UNDERSTANDING_ENDPOINT"] = "https://example.services.ai.azure.com/",
            ["CONTENT_UNDERSTANDING_MAX_DOCUMENT_PAGES"] = "250"
        });
        var policy = new ExtractionPolicy(configuration);
        Assert.True(policy.RouteForPdfPages(Request("report.pdf", "report.pdf"), 251).PreserveDocumentPages);
        configuration["CONTENT_UNDERSTANDING_MAX_DOCUMENT_PAGES"] = "301";
        Assert.Throws<InvalidOperationException>(() => policy.RouteForPdfPages(Request("report.pdf", "report.pdf"), 251));
    }

    private static DocumentRequest Request(string filename, string path) => new(filename, path, "source", "account");
    private static IConfigurationRoot Configuration(Dictionary<string, string?>? values = null) =>
        new ConfigurationBuilder().AddInMemoryCollection(values ?? new()).Build();
}
