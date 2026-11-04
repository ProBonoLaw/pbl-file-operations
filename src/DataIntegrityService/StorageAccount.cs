using Azure.Core;
using Azure.Identity;
using Azure.Storage.Blobs;
using System.Text.RegularExpressions;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

public static partial class StorageAccount
{
    private static readonly DefaultAzureCredential Credential = new();

    public static Uri ServiceUri(string accountName, string service)
    {
        if (!AccountNamePattern().IsMatch(accountName))
            throw new InvalidOperationException("STORAGE_ACCOUNT_NAME must be a valid Azure storage account name");
        if (service is not ("blob" or "table"))
            throw new ArgumentOutOfRangeException(nameof(service));
        return new Uri($"https://{accountName}.{service}.core.windows.net");
    }

    public static BlobServiceClient Blobs(string accountName, TokenCredential? credential = null,
        BlobClientOptions? options = null) =>
        new(ServiceUri(accountName, "blob"), credential ?? Credential, options);

    public static string ConfiguredSource(string? accountName, string? legacySource, string service)
    {
        if (accountName is not null) return ServiceUri(accountName, service).AbsoluteUri;
        return !string.IsNullOrEmpty(legacySource) ? legacySource
            : throw new InvalidOperationException("STORAGE_ACCOUNT_NAME or a storage service URL is required");
    }

    public static Uri? IdentityServiceUri(string source)
    {
        if (!source.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return null;
        var uri = new Uri(source);
        if (uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.AbsolutePath != "/")
            throw new InvalidOperationException("Storage identity configuration requires a service URL without credentials or a path");
        return uri;
    }

    public static BlobServiceClient BlobsFromSource(string source, TokenCredential? credential = null,
        BlobClientOptions? options = null) => IdentityServiceUri(source) is { } uri
            ? new(uri, credential ?? Credential, options)
            : new(source, options);

    [GeneratedRegex(@"\A[a-z0-9]{3,24}\z")]
    private static partial Regex AccountNamePattern();
}
