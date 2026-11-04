using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FileOperations;
using Xunit;

namespace FileOperations.Tests;

public class NotificationTests
{
    private const string TestNotificationUrl =
        "http://notification-service.email-operations.svc.cluster.local/api/sendNotice";

    [Theory]
    [InlineData(IngestionStatus.PRELIMINARY)]
    [InlineData(IngestionStatus.EVIDENCE_EXTRACTION)]
    [InlineData(IngestionStatus.SUCCESS)]
    [InlineData(IngestionStatus.FAILED)]
    public async Task SendsIngestionNotificationToEachAccountRecipient(IngestionStatus status)
    {
        var previousUrl = Environment.GetEnvironmentVariable("NOTIFICATION_URL");
        var previousKey = Environment.GetEnvironmentVariable("NOTIFICATION_API_KEY");
        try
        {
            Environment.SetEnvironmentVariable("NOTIFICATION_URL", TestNotificationUrl);
            var notificationUrl = Environment.GetEnvironmentVariable("NOTIFICATION_URL");
            Environment.SetEnvironmentVariable("NOTIFICATION_API_KEY", "test-function-key");
            var handler = new RecordingHandler();
            var recipients = new StaticRecipientStore("oid-1", "oid-2");
            var notifications = new FileOperations.NotificationService(recipients,
                FileOperations.NotificationService.CreateClient(new HttpClient(handler)));

            await notifications.SendIngestionAsync("account-1", status, "opaque-id",
                "/Shared Documents/folder/file.pdf", CancellationToken.None);

            Assert.Equal("account-1", recipients.AccountId);
            Assert.Equal(2, handler.Requests.Count);
            using var body = JsonDocument.Parse(handler.Requests[0].Body);
            var notification = body.RootElement;
            Assert.Equal("oid-1", notification.GetProperty("oid").GetString());
            Assert.Equal("INGESTION", notification.GetProperty("notificationType").GetString());
            Assert.Equal("account-1", notification.GetProperty("data").GetProperty("accountId").GetString());
            Assert.Equal(status.ToString(), notification.GetProperty("data").GetProperty("status").GetString());
            Assert.Equal("/Shared Documents/folder/file.pdf",
                notification.GetProperty("data").GetProperty("filepath").GetString());
            Assert.Equal(notificationUrl, handler.Requests[0].Url?.ToString());
            Assert.Null(handler.Requests[0].FunctionKey);
            Assert.True(JsonNode.DeepEquals(JsonNode.Parse(handler.Requests[0].Body), JsonNode.Parse($$"""
                {
                  "oid": "oid-1",
                  "notificationType": "INGESTION",
                  "data": {
                    "accountId": "account-1",
                    "status": "{{status}}",
                    "filepath": "/Shared Documents/folder/file.pdf"
                  }
                }
                """)));
        }
        finally
        {
            Environment.SetEnvironmentVariable("NOTIFICATION_URL", previousUrl);
            Environment.SetEnvironmentVariable("NOTIFICATION_API_KEY", previousKey);
        }
    }

    [Fact]
    public async Task SendsFeedbackAlertWithExpectedDataAndFileIdFallback()
    {
        var previousUrl = Environment.GetEnvironmentVariable("NOTIFICATION_URL");
        var previousKey = Environment.GetEnvironmentVariable("NOTIFICATION_API_KEY");
        try
        {
            Environment.SetEnvironmentVariable("NOTIFICATION_URL", TestNotificationUrl);
            Environment.SetEnvironmentVariable("NOTIFICATION_API_KEY", null);
            var handler = new RecordingHandler();
            var notifications = new FileOperations.NotificationService(new StaticRecipientStore("oid-1"),
                FileOperations.NotificationService.CreateClient(new HttpClient(handler)));

            await notifications.SendFeedbackRequiredAsync("account-1", "feedback-1", "source-1",
                "/Shared Documents/_GeneratedDocuments/request/feedback.md", CancellationToken.None);
            await notifications.SendIngestionAsync("account-1", IngestionStatus.FAILED, "opaque-id", null,
                CancellationToken.None);

            using var feedbackBody = JsonDocument.Parse(handler.Requests[0].Body);
            var feedback = feedbackBody.RootElement;
            Assert.Equal("ALERT", feedback.GetProperty("notificationType").GetString());
            Assert.Equal("FEEDBACK_REQUIRED", feedback.GetProperty("data").GetProperty("status").GetString());
            Assert.Equal("feedback-1",
                feedback.GetProperty("data").GetProperty("clientFeedbackRequestId").GetString());
            Assert.Equal("source-1", feedback.GetProperty("data").GetProperty("sourceId").GetString());
            Assert.True(JsonNode.DeepEquals(JsonNode.Parse(handler.Requests[0].Body), JsonNode.Parse("""
                {
                  "oid": "oid-1",
                  "notificationType": "ALERT",
                  "data": {
                    "accountId": "account-1",
                    "status": "FEEDBACK_REQUIRED",
                    "clientFeedbackRequestId": "feedback-1",
                    "sourceId": "source-1",
                    "markdownPath": "/Shared Documents/_GeneratedDocuments/request/feedback.md"
                  }
                }
                """)));

            using var ingestionBody = JsonDocument.Parse(handler.Requests[1].Body);
            Assert.Equal("opaque-id", ingestionBody.RootElement.GetProperty("data")
                .GetProperty("filepath").GetString());
        }
        finally
        {
            Environment.SetEnvironmentVariable("NOTIFICATION_URL", previousUrl);
            Environment.SetEnvironmentVariable("NOTIFICATION_API_KEY", previousKey);
        }
    }

    [Theory]
    [InlineData("http://localhost:5083/")]
    [InlineData("http://localhost:5083/api/sendNotice")]
    public async Task NormalizesConfiguredEndpointToServiceRoot(string endpoint)
    {
        var previous = Environment.GetEnvironmentVariable("NOTIFICATION_URL");
        try
        {
            Environment.SetEnvironmentVariable("NOTIFICATION_URL", endpoint);
            var handler = new RecordingHandler();
            var notifications = new FileOperations.NotificationService(new StaticRecipientStore("oid-1"),
                FileOperations.NotificationService.CreateClient(new HttpClient(handler)));
            await notifications.SendIngestionAsync("account", IngestionStatus.PRELIMINARY, "file", null,
                CancellationToken.None);
            Assert.Equal("http://localhost:5083/api/sendNotice", Assert.Single(handler.Requests).Url!.ToString());
        }
        finally { Environment.SetEnvironmentVariable("NOTIFICATION_URL", previous); }
    }

    [Theory]
    [InlineData(HttpStatusCode.OK)]
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task PropagatesNotificationRejectionWithoutAutomaticallyResending(HttpStatusCode status)
    {
        var handler = new RecordingHandler(status);
        var notifications = new FileOperations.NotificationService(new StaticRecipientStore("oid-1", "oid-2"),
            new NotificationClient(new HttpClient(handler) { BaseAddress = new Uri("http://localhost/") }));
        var error = await Assert.ThrowsAsync<NotificationTransmissionException>(() =>
            notifications.SendIngestionAsync("account", IngestionStatus.PRELIMINARY, "file", null,
                CancellationToken.None));
        Assert.Equal(status, error.StatusCode);
        Assert.Equal("{}", error.ResponseBody);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task PropagatesNotificationCancellation()
    {
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var notifications = new FileOperations.NotificationService(new StaticRecipientStore("oid-1"),
            new NotificationClient(new HttpClient(new RecordingHandler()) { BaseAddress = new Uri("http://localhost/") }));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => notifications.SendIngestionAsync(
            "account", IngestionStatus.PRELIMINARY, "file", null, cancelled.Token));
    }

    private sealed class StaticRecipientStore(params string[] recipients) : INotificationRecipientStore
    {
        public string? AccountId { get; private set; }

        public Task<IReadOnlyList<string>> GetRecipientsAsync(string accountId,
            CancellationToken cancellationToken)
        {
            AccountId = accountId;
            return Task.FromResult<IReadOnlyList<string>>(recipients);
        }
    }

    private sealed class RecordingHandler(HttpStatusCode status = HttpStatusCode.Accepted) : HttpMessageHandler
    {
        public List<RecordedRequest> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var body = await request.Content!.ReadAsStringAsync(cancellationToken);
            var functionKey = request.Headers.TryGetValues("x-functions-key", out var keys)
                ? keys.Single()
                : null;
            Requests.Add(new RecordedRequest(body, functionKey, request.RequestUri));
            return new HttpResponseMessage(status)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json")
            };
        }
    }

    private sealed record RecordedRequest(string Body, string? FunctionKey, Uri? Url);
}
