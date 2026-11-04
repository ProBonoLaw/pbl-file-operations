using System.Net;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.Storage.Blobs;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using Xunit;

namespace FileOperations.Tests;

public class StorageAccountTests
{
    [Fact]
    public async Task BlobWritesUseStorageBearerTokensWithoutAnAccountKey()
    {
        var credential = new StorageCredential();
        using var handler = new StorageHandler();
        using var http = new HttpClient(handler);
        var blobs = StorageAccount.Blobs("examplestoragetest", credential,
            new BlobClientOptions { Transport = new HttpClientTransport(http) });
        await blobs.GetBlobContainerClient("test-state").CreateIfNotExistsAsync();
        Assert.Equal("https://storage.azure.com/.default", Assert.Single(credential.Scopes));
        Assert.Equal("Bearer rbac-test-token", handler.Authorization);
        Assert.Equal("examplestoragetest.blob.core.windows.net", handler.Uri?.Host);
        Assert.False(blobs.GetBlobContainerClient("test-state").CanGenerateSasUri);
        Assert.Equal("https://examplestoragetest.table.core.windows.net/",
            StorageAccount.ServiceUri("examplestoragetest", "table").AbsoluteUri);
    }

    [Theory]
    [InlineData("")]
    [InlineData("old-account")]
    [InlineData("AccountName=old;AccountKey=key")]
    [InlineData("https://example.test")]
    [InlineData("account\n")]
    public void RejectsConnectionStringsAndInvalidAccountNames(string value) =>
        Assert.Throws<InvalidOperationException>(() => StorageAccount.ServiceUri(value, "blob"));

    private sealed class StorageCredential : TokenCredential
    {
        public string[] Scopes { get; private set; } = [];
        public override AccessToken GetToken(TokenRequestContext context, CancellationToken cancellationToken)
        {
            Scopes = context.Scopes;
            return new AccessToken("rbac-test-token", DateTimeOffset.UtcNow.AddHours(1));
        }
        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext context, CancellationToken cancellationToken) =>
            ValueTask.FromResult(GetToken(context, cancellationToken));
    }

    private sealed class StorageHandler : HttpMessageHandler
    {
        public string? Authorization { get; private set; }
        public Uri? Uri { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Authorization = request.Headers.Authorization?.ToString();
            Uri = request.RequestUri;
            var response = new HttpResponseMessage(HttpStatusCode.Created);
            response.Headers.TryAddWithoutValidation("ETag", "\"test\"");
            response.Headers.TryAddWithoutValidation("Last-Modified", "Mon, 26 Oct 2026 00:00:00 GMT");
            return Task.FromResult(response);
        }
    }
}
