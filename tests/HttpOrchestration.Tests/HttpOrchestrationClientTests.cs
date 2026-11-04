using System.Net;
using System.Net.Http.Headers;
using System.Text;
using DaatPhoenix.HttpOrchestration;
using Xunit;

namespace HttpOrchestration.Tests;

public class HttpOrchestrationClientTests
{
    private static readonly Uri FunctionUri = new("https://example.test/api/convert");
    private static readonly Uri StatusUri = new("https://example.test/runtime/webhooks/durabletask/instances/123?code=test-key");

    [Fact]
    public async Task WaitsForDurableOrchestrationToComplete()
    {
        var running = Json(HttpStatusCode.Accepted, """{"runtimeStatus":"Running"}""");
        running.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.Zero);
        using var handler = new ScriptedHandler(
            StartResponse(), running,
            Json(HttpStatusCode.OK,
                """{"runtimeStatus":"Completed","output":{"ContainerName":"results","ContainerPath":"converted.md"}}"""));
        using var client = new HttpClient(handler);

        var result = await NewClient(client).SendAndWaitForCompletionAsync(HttpMethod.Post, FunctionUri,
            new { file = "test.pdf" }, "conversion", null, CancellationToken.None);

        Assert.Equal("results", result!.Value.GetProperty("output").GetProperty("ContainerName").GetString());
        Assert.Equal([HttpMethod.Post, HttpMethod.Get, HttpMethod.Get],
            handler.Requests.Select(request => request.Method));
        Assert.All(handler.Requests.Skip(1), request => Assert.Equal(StatusUri, request.Url));
    }

    [Fact]
    public async Task FailsWhenDurableOrchestrationFails()
    {
        using var handler = new ScriptedHandler(StartResponse(),
            Json(HttpStatusCode.OK, """{"runtimeStatus":"Failed"}"""));
        using var client = new HttpClient(handler);

        var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
            NewClient(client).SendAndWaitForCompletionAsync(HttpMethod.Post, FunctionUri,
                new { }, "conversion", null, CancellationToken.None));

        Assert.Contains("Failed", error.Message);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task RejectsStatusUrlFromAnotherHost()
    {
        using var handler = new ScriptedHandler(Json(HttpStatusCode.Accepted,
            """{"statusQueryGetUri":"https://other.test/status?code=test-key"}"""));
        using var client = new HttpClient(handler);

        await Assert.ThrowsAsync<InvalidDataException>(() =>
            NewClient(client).SendAndWaitForCompletionAsync(HttpMethod.Post, FunctionUri,
                new { }, "conversion", null, CancellationToken.None));

        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task RejectsAcceptedResponseWithoutStatusUrl()
    {
        using var handler = new ScriptedHandler(Json(HttpStatusCode.Accepted,
            """{"instanceId":"123"}"""));
        using var client = new HttpClient(handler);

        var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
            NewClient(client).SendAndWaitForCompletionAsync(HttpMethod.Post, FunctionUri,
                new { }, "conversion", null, CancellationToken.None));

        Assert.Contains("HTTP 202 without a statusQueryGetUri", error.Message);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task PollsLocationHeaderUntilAsyncOperationCompletes()
    {
        var start = Json(HttpStatusCode.Accepted, "");
        start.Headers.Location = StatusUri;
        start.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.Zero);
        var running = Json(HttpStatusCode.Accepted, "");
        running.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.Zero);
        using var handler = new ScriptedHandler(start, running,
            Json(HttpStatusCode.OK, """{"ContainerName":"results","ContainerPath":"converted.md"}"""));
        using var client = new HttpClient(handler);

        var result = await NewClient(client).SendAndWaitForCompletionAsync(HttpMethod.Post, FunctionUri,
            new { }, "conversion", null, CancellationToken.None);

        Assert.Equal("results", result!.Value.GetProperty("ContainerName").GetString());
        Assert.Equal([HttpMethod.Post, HttpMethod.Get, HttpMethod.Get],
            handler.Requests.Select(request => request.Method));
        Assert.All(handler.Requests.Skip(1), request => Assert.Equal(StatusUri, request.Url));
    }

    [Fact]
    public async Task RejectsLocationHeaderFromAnotherHost()
    {
        var start = Json(HttpStatusCode.Accepted, "");
        start.Headers.Location = new Uri("https://attacker.test/status");
        using var handler = new ScriptedHandler(start);
        using var client = new HttpClient(handler);

        var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
            NewClient(client).SendAndWaitForCompletionAsync(HttpMethod.Post, FunctionUri,
                new { }, "conversion", null, CancellationToken.None));

        Assert.Contains("invalid status URL", error.Message);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task RetriesTransientResponses()
    {
        using var handler = new ScriptedHandler(Json(HttpStatusCode.ServiceUnavailable, ""),
            Json(HttpStatusCode.OK, """{"done":true}"""));
        using var client = new HttpClient(handler);

        var result = await NewClient(client).SendAsync(HttpMethod.Get, FunctionUri, null,
            "status", null, CancellationToken.None, retryCount: 2, retryDelay: TimeSpan.Zero);

        Assert.True(result!.Value.GetProperty("done").GetBoolean());
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task RejectsRelativeEndpoint()
    {
        using var client = new HttpClient(new ScriptedHandler());

        await Assert.ThrowsAsync<ArgumentException>(() =>
            NewClient(client).SendAsync(HttpMethod.Get, new Uri("/api/status", UriKind.Relative), null,
                null, null, CancellationToken.None));
    }

    private static HttpOrchestrationClient NewClient(HttpClient client) => new(client, options:
        new HttpOrchestrationOptions { PollingInterval = TimeSpan.Zero });

    private static HttpResponseMessage StartResponse() => Json(HttpStatusCode.Accepted,
        $$"""{"statusQueryGetUri":"{{StatusUri}}"}""");

    private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json")
    };

    private sealed class ScriptedHandler(params HttpResponseMessage[] responses) : HttpMessageHandler
    {
        private readonly Queue<HttpResponseMessage> responses = new(responses);
        public List<(HttpMethod Method, Uri Url)> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Requests.Add((request.Method, request.RequestUri!));
            return Task.FromResult(responses.Dequeue());
        }
    }
}
