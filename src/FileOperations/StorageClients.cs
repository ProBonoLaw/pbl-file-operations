using Azure.Data.Tables;
using Azure.Identity;
using Azure.Storage.Blobs;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

namespace FileOperations;

/// <summary>Accept service URLs for workload identity and legacy connection strings during rollout.</summary>
internal static class StorageClients
{
    private static readonly DefaultAzureCredential Credential = new();

    public static BlobServiceClient Blobs(string source) =>
        StorageAccount.BlobsFromSource(source);

    public static BlobContainerClient Container(string source, string name) =>
        Blobs(source).GetBlobContainerClient(name);

    public static TableServiceClient Tables(string source) =>
        StorageAccount.IdentityServiceUri(source) is { } uri
            ? new TableServiceClient(uri, Credential)
            : new TableServiceClient(source);

    public static TableClient Table(string source, string name) => Tables(source).GetTableClient(name);
}
