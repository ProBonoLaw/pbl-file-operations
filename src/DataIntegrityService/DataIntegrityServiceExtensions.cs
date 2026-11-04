using Azure;
using Azure.AI.DocumentIntelligence;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration.Telemetry;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

public static class DataIntegrityServiceExtensions
{
    public static IServiceCollection AddDataIntegrityTransformation(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddSingleton(new DataIntegrityOptions(Required(configuration, "INTEGRITY_OUTPUT_CONTAINER")));
        services.AddSingleton(_ => StorageAccount.BlobsFromSource(StorageAccount.ConfiguredSource(
            configuration["STORAGE_ACCOUNT_NAME"], configuration["BLOB_CONNECTION_STRING"], "blob")));
        services.AddTransient(_ => new DocumentIntelligenceClient(
            new Uri(Required(configuration, "DI_ENDPOINT")),
            new AzureKeyCredential(Required(configuration, "DI_KEY"))));
        services.AddHttpClient<VideoIndexerClient>();
        // Per-request deadlines in ContentUnderstandingClient also cover streamed private inputs.
        services.AddHttpClient("content-understanding", client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
        services.AddSingleton<ExtractionPolicy>();
        services.AddScoped<ContentUnderstandingActivity>();
        services.AddHostedService<ContentUnderstandingSnapshotWorker>();
        services.AddScoped<DocumentIntelligenceResultActivity>();
        services.AddScoped<NormalizerActivity>();
        services.AddScoped<DataIntegrityTransformer>();
        services.AddScoped<DataIntegrityFileLookup>();
        services.AddSingleton<Microsoft.ApplicationInsights.Extensibility.ITelemetryInitializer,
            DataIntegrityTelemetryInitializer>();
        return services;
    }

    private static string Required(IConfiguration configuration, string name) =>
        configuration[name] is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required setting: {name}");
}
