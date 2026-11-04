using System.Net;
using FileOperations;
using Xunit;

namespace FileOperations.Tests;

public class HttpFunctionsTests
{
    [Fact]
    public async Task ResolvesConfiguredEndpointAndFunctionKey()
    {
        const string endpointSetting = "HTTP_FUNCTIONS_TEST_URL";
        const string keySetting = "HTTP_FUNCTIONS_TEST_API_KEY";
        var previousEndpoint = Environment.GetEnvironmentVariable(endpointSetting);
        var previousKey = Environment.GetEnvironmentVariable(keySetting);
        Environment.SetEnvironmentVariable(endpointSetting, "https://example.test/api/convert");
        Environment.SetEnvironmentVariable(keySetting, "test-key");
        try
        {
            using var handler = new RecordingHandler();
            var functions = new HttpFunctions(new HttpClient(handler));

            await functions.SendAsync("POST", endpointSetting, new { file = "sample.pdf" },
                CancellationToken.None);

            Assert.Equal("https://example.test/api/convert", handler.Url?.ToString());
            Assert.Equal("test-key", handler.FunctionKey);
        }
        finally
        {
            Environment.SetEnvironmentVariable(endpointSetting, previousEndpoint);
            Environment.SetEnvironmentVariable(keySetting, previousKey);
        }
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public Uri? Url { get; private set; }
        public string? FunctionKey { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Url = request.RequestUri;
            FunctionKey = request.Headers.GetValues("x-functions-key").Single();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        }
    }
}
