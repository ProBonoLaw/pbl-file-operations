using FileOperations;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using Azure.Storage.Blobs;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

public sealed class StorageClientsTests
{
    [Fact]
    public void ServiceUrlsUseIdentityWithoutAccountKeys()
    {
        var blobs = StorageClients.Blobs("https://examplestoragetest.blob.core.windows.net");
        var container = StorageClients.Container(blobs.Uri.AbsoluteUri, "file-operations-checkpoints");
        var table = StorageClients.Table("https://examplestoragetest.table.core.windows.net", "IngestionProgress");
        Assert.Equal("examplestoragetest", blobs.AccountName);
        Assert.False(container.CanGenerateSasUri);
        Assert.Equal("file-operations-checkpoints", container.Name);
        Assert.Equal("IngestionProgress", table.Name);
        Assert.Equal("https://examplestoragetest.table.core.windows.net/IngestionProgress", table.Uri.AbsoluteUri);
    }

    [Fact]
    public void ExistingConnectionStringsRemainSupportedDuringRollout()
    {
        const string connection = "UseDevelopmentStorage=true";
        Assert.Equal("devstoreaccount1", StorageClients.Blobs(connection).AccountName);
        Assert.True(StorageClients.Container(connection, "checkpoints").CanGenerateSasUri);
        Assert.Equal("IngestionProgress", StorageClients.Table(connection, "IngestionProgress").Name);
    }

    [Theory]
    [InlineData("examplestoragetest")]
    [InlineData("examplestorageprod")]
    public void AccountNameTakesPrecedenceOverLegacySettings(string account)
    {
        var blobSource = StorageAccount.ConfiguredSource(account, "UseDevelopmentStorage=true", "blob");
        var tableSource = StorageAccount.ConfiguredSource(account, "UseDevelopmentStorage=true", "table");
        Assert.Equal(account, StorageClients.Blobs(blobSource).AccountName);
        Assert.False(StorageClients.Container(blobSource, "checkpoints").CanGenerateSasUri);
        Assert.Equal($"{account}.table.core.windows.net", StorageClients.Table(tableSource, "Progress").Uri.Host);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("examplestorageprod")]
    public void IntegrityRegistrationAcceptsAccountNamesAndExistingServiceUrlSettings(string? account)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["STORAGE_ACCOUNT_NAME"] = account,
            ["BLOB_CONNECTION_STRING"] = "https://examplestoragetest.blob.core.windows.net",
            ["INTEGRITY_OUTPUT_CONTAINER"] = "test-integrity-results"
        }).Build();
        using var services = new ServiceCollection().AddDataIntegrityTransformation(configuration).BuildServiceProvider();
        var blobs = services.GetRequiredService<BlobServiceClient>();
        Assert.Equal(account ?? "examplestoragetest", blobs.AccountName);
        Assert.False(blobs.GetBlobContainerClient("input").CanGenerateSasUri);
    }

    [Theory]
    [InlineData("")]
    [InlineData("invalid-account")]
    public void InvalidExplicitAccountsDoNotFallBackToLegacyCredentials(string account) =>
        Assert.Throws<InvalidOperationException>(() =>
            StorageAccount.ConfiguredSource(account, "UseDevelopmentStorage=true", "blob"));

    [Theory]
    [InlineData("https://example.blob.core.windows.net/input")]
    [InlineData("https://example.blob.core.windows.net/?sig=secret")]
    [InlineData("https://user:password@example.blob.core.windows.net/")]
    public void RejectsCredentialsAndPathsInIdentityServiceUrls(string source) =>
        Assert.Throws<InvalidOperationException>(() => StorageClients.Blobs(source));
}
