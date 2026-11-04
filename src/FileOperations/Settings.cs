using Azure.Messaging.EventHubs;
using Azure.Data.Tables;
using Azure.Storage.Blobs;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;

namespace FileOperations;

public sealed class MissingSettingException(string name) : InvalidOperationException($"Missing required setting: {name}");

public static class Settings
{
    private static IConfiguration? configuration;

    public static void Configure(IConfigurationManager configurationManager)
    {
        var path = Environment.GetEnvironmentVariable("APPSETTINGS_FILE") ?? "/mnt/keyvault/appsettings.json";
        var fullPath = Path.GetFullPath(path);
        var directory = Path.GetDirectoryName(fullPath)!;
        if (Directory.Exists(directory))
        {
            configurationManager.AddJsonFile(new PhysicalFileProvider(directory), Path.GetFileName(fullPath),
                optional: true, reloadOnChange: true);
            configurationManager.AddEnvironmentVariables();
        }
        configuration = configurationManager;
        var applicationInsightsConnectionString = configurationManager["APPLICATIONINSIGHTS_CONNECTION_STRING"];
        if (!string.IsNullOrWhiteSpace(applicationInsightsConnectionString))
            configurationManager["ApplicationInsights:ConnectionString"] = applicationInsightsConnectionString;
    }

    public static string? Get(string name) => Environment.GetEnvironmentVariable(name) ?? configuration?[name];

    public static string Required(string name) =>
        Get(name) is { Length: > 0 } value
            ? value : throw new MissingSettingException(name);

    public static BlobServiceClient StorageBlobs(string legacySetting = "BLOB_CONNECTION_STRING") =>
        StorageClients.Blobs(StorageAccount.ConfiguredSource(Get("STORAGE_ACCOUNT_NAME"),
            Get(legacySetting) ?? Get("BLOB_CONNECTION_STRING"), "blob"));

    public static TableServiceClient StorageTables() =>
        StorageClients.Tables(StorageAccount.ConfiguredSource(Get("STORAGE_ACCOUNT_NAME"),
            Get("TABLE_CONNECTION_STRING"), "table"));

    public static EventHubConnectionOptions EventHubConnectionOptions()
    {
        var configuredTransport = Get("EVENTHUB_TRANSPORT_TYPE");
        if (string.IsNullOrWhiteSpace(configuredTransport)) return new EventHubConnectionOptions();
        if (!Enum.TryParse<EventHubsTransportType>(configuredTransport, true, out var transport) ||
            !Enum.IsDefined(transport))
            throw new InvalidOperationException(
                "EVENTHUB_TRANSPORT_TYPE must be AmqpTcp or AmqpWebSockets");
        return new EventHubConnectionOptions { TransportType = transport };
    }
}
