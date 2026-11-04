using System.Net;
using System.Text;
using Azure.Core;
using FileOperations;
using Xunit;

namespace FileOperations.Tests;

public sealed class SharePointChangeFeedTests
{
    [Fact]
    public async Task ReadsGraphDeltaPagesAndReturnsDeltaLink()
    {
        using var settings = new SharePointSettings();
        var handler = new RecordingHandler(request => request.RequestUri!.AbsolutePath switch
        {
            "/v1.0/sites/contoso.sharepoint.com:/sites/account" => JsonResponse("""
                {"id":"site-id"}
                """),
            "/v1.0/sites/site-id/lists" => JsonResponse("""
                {"value":[{"id":"documents-list","displayName":"Documents"}]}
                """),
            "/v1.0/sites/site-id/lists/documents-list/items/delta" when
                request.RequestUri.Query.Length == 0 => JsonResponse("""
                {
                  "value":[
                    {"id":"42","webUrl":"https://contoso.sharepoint.com/sites/account/Shared%20Documents/file.pdf","contentType":{"name":"Document"}},
                    {"id":"12","webUrl":"https://contoso.sharepoint.com/sites/account/Shared%20Documents/folder","contentType":{"name":"Folder"}}
                  ],
                  "@odata.nextLink":"https://graph.microsoft.com/v1.0/sites/site-id/lists/documents-list/items/delta?skiptoken=page2"
                }
                """),
            "/v1.0/sites/site-id/lists/documents-list/items/delta" => JsonResponse("""
                {
                  "value":[{"id":"9","deleted":{"state":"deleted"}}],
                  "@odata.deltaLink":"https://graph.microsoft.com/v1.0/sites/site-id/lists/documents-list/items/delta?token=latest"
                }
                """),
            _ => new HttpResponseMessage(HttpStatusCode.NotFound)
        });
        var credential = new TestTokenCredential();
        var feed = new SharePointChangeFeed(new HttpClient(handler), credential);

        var batch = await feed.GetChangesAsync("account", null, CancellationToken.None);

        Assert.NotNull(batch);
        Assert.Equal(3, batch.Changes.Count);
        Assert.Equal("42", batch.Changes[0].GetProperty("id").GetString());
        Assert.Equal("Document", batch.Changes[0].GetProperty("contentType").GetProperty("name").GetString());
        Assert.Equal("https://contoso.sharepoint.com/sites/account/Shared%20Documents/file.pdf",
            batch.Changes[0].GetProperty("webUrl").GetString());
        Assert.Equal("Folder", batch.Changes[1].GetProperty("contentType").GetProperty("name").GetString());
        Assert.True(batch.Changes[2].TryGetProperty("deleted", out _));
        Assert.EndsWith("?token=latest", batch.DeltaLink);
        Assert.Equal(4, handler.Requests.Count);
        Assert.All(handler.Requests, request =>
            Assert.Equal("Bearer test-access-token", request.Authorization));
        Assert.All(credential.Scopes, scope => Assert.Equal("https://graph.microsoft.com/.default", scope));
    }

    [Fact]
    public async Task UsesSavedDeltaLinkWithoutResolvingSiteAgain()
    {
        using var settings = new SharePointSettings();
        var handler = new RecordingHandler(_ => JsonResponse("""
            {"value":[],"@odata.deltaLink":"https://graph.microsoft.com/v1.0/delta?token=next"}
            """));
        var feed = new SharePointChangeFeed(new HttpClient(handler), new TestTokenCredential());

        var batch = await feed.GetChangesAsync("account",
            "https://graph.microsoft.com/v1.0/delta?token=current", CancellationToken.None);

        Assert.NotNull(batch);
        Assert.Empty(batch.Changes);
        Assert.Equal("https://graph.microsoft.com/v1.0/delta?token=current", handler.Requests.Single().Uri);
    }

    [Fact]
    public async Task RejectsDeltaLinksOutsideConfiguredGraphHost()
    {
        using var settings = new SharePointSettings();
        var handler = new RecordingHandler(_ => throw new InvalidOperationException("Unexpected HTTP request"));
        var feed = new SharePointChangeFeed(new HttpClient(handler), new TestTokenCredential());

        await Assert.ThrowsAsync<InvalidDataException>(() => feed.GetChangesAsync("account",
            "https://attacker.example/delta", CancellationToken.None));
        Assert.Empty(handler.Requests);
    }

    [Theory]
    [InlineData("http://graph.microsoft.com/v1.0")]
    [InlineData("/v1.0")]
    public void RejectsGraphUrlsThatAreNotAbsoluteHttps(string graphUrl)
    {
        using var settings = new SharePointSettings();
        Environment.SetEnvironmentVariable("GRAPH_URL", graphUrl);

        var exception = Assert.Throws<InvalidOperationException>(() =>
            new SharePointChangeFeed(new HttpClient(), new TestTokenCredential()));

        Assert.Contains("GRAPH_URL must be an absolute HTTPS URL", exception.Message);
    }

    [Fact]
    public async Task ReportsGraphAuthorizationFailureAndStatusCode()
    {
        using var settings = new SharePointSettings();
        var handler = new RecordingHandler(_ => new HttpResponseMessage(HttpStatusCode.Unauthorized));
        var feed = new SharePointChangeFeed(new HttpClient(handler), new TestTokenCredential());

        var exception = await Assert.ThrowsAsync<SharePointGraphAuthorizationException>(() =>
            feed.GetChangesAsync("account", null, CancellationToken.None));

        Assert.Equal(HttpStatusCode.Unauthorized, exception.StatusCode);
    }

    private static HttpResponseMessage JsonResponse(string body) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json")
    };

    private sealed class RecordingHandler(Func<HttpRequestMessage, HttpResponseMessage> responder)
        : HttpMessageHandler
    {
        public List<(string Uri, string? Authorization)> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add((request.RequestUri!.AbsoluteUri,
                request.Headers.Authorization?.ToString()));
            return Task.FromResult(responder(request));
        }
    }

    private sealed class TestTokenCredential : TokenCredential
    {
        public List<string> Scopes { get; } = [];

        public override AccessToken GetToken(TokenRequestContext requestContext,
            CancellationToken cancellationToken)
        {
            Scopes.AddRange(requestContext.Scopes);
            return new AccessToken("test-access-token", DateTimeOffset.UtcNow.AddMinutes(5));
        }

        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext,
            CancellationToken cancellationToken)
        {
            Scopes.AddRange(requestContext.Scopes);
            return ValueTask.FromResult(new AccessToken("test-access-token", DateTimeOffset.UtcNow.AddMinutes(5)));
        }
    }

    private sealed class SharePointSettings : IDisposable
    {
        private readonly Dictionary<string, string?> originalValues = new(StringComparer.Ordinal)
        {
            ["SHAREPOINT_HOST"] = Environment.GetEnvironmentVariable("SHAREPOINT_HOST"),
            ["SHAREPOINT_SITE_PREFIX"] = Environment.GetEnvironmentVariable("SHAREPOINT_SITE_PREFIX"),
            ["GRAPH_URL"] = Environment.GetEnvironmentVariable("GRAPH_URL")
        };

        public SharePointSettings()
        {
            Environment.SetEnvironmentVariable("SHAREPOINT_HOST", "contoso.sharepoint.com");
            Environment.SetEnvironmentVariable("SHAREPOINT_SITE_PREFIX", "/sites");
            Environment.SetEnvironmentVariable("GRAPH_URL", "https://graph.microsoft.com/v1.0");
        }

        public void Dispose()
        {
            foreach (var (name, value) in originalValues)
                Environment.SetEnvironmentVariable(name, value);
        }
    }
}
