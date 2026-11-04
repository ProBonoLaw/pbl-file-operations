using Microsoft.Azure.Cosmos;

namespace FileOperations;

public interface INotificationRecipientStore
{
    Task<IReadOnlyList<string>> GetRecipientsAsync(string accountId, CancellationToken cancellationToken);
}

public sealed class CosmosNotificationRecipientStore(CosmosClient cosmos) : INotificationRecipientStore
{
    private const string RootAccountId = "00000000-0000-0000-0000-000000000000";
    private readonly Container accounts = cosmos.GetContainer(
        Settings.Get("COSMOS_DATABASE") ?? "db_conversation_history", "accounts");

    public async Task<IReadOnlyList<string>> GetRecipientsAsync(string accountId,
        CancellationToken cancellationToken)
    {
        var query = new QueryDefinition(
            "SELECT DISTINCT VALUE o FROM c JOIN o IN c.oids JOIN a IN c.casesAccounts " +
            "WHERE c.accountId = @root AND a.accountId = @account")
            .WithParameter("@root", RootAccountId)
            .WithParameter("@account", accountId);
        using var iterator = accounts.GetItemQueryIterator<string>(query,
            requestOptions: new QueryRequestOptions { PartitionKey = new PartitionKey(RootAccountId) });
        var recipients = new List<string>();
        while (iterator.HasMoreResults)
        {
            var page = await iterator.ReadNextAsync(cancellationToken);
            recipients.AddRange(page.Where(oid => !string.IsNullOrWhiteSpace(oid)));
        }
        return recipients;
    }
}

public sealed class NotificationService(
    INotificationRecipientStore recipients,
    NotificationClient client,
    ILogger? logger = null)
{
    public static NotificationClient CreateClient(HttpClient httpClient)
    {
        var configuredUrl = Settings.Required("NOTIFICATION_URL");
        if (!Uri.TryCreate(configuredUrl, UriKind.Absolute, out var endpoint) ||
            endpoint.Scheme is not ("http" or "https") ||
            endpoint.AbsolutePath is not ("/" or "/api/sendNotice") ||
            !string.IsNullOrEmpty(endpoint.Query) || !string.IsNullOrEmpty(endpoint.Fragment) ||
            !string.IsNullOrEmpty(endpoint.UserInfo))
            throw new InvalidDataException("NOTIFICATION_URL must be an HTTP or HTTPS service root or /api/sendNotice URL");
        httpClient.BaseAddress = new Uri(endpoint.GetLeftPart(UriPartial.Authority) + "/");
        return new NotificationClient(httpClient);
    }

    public Task SendIngestionAsync(string accountId, IngestionStatus status, string fileId, string? filepath,
        CancellationToken cancellationToken) => SendToAccountAsync(accountId, oid => new
        {
            Oid = oid,
            NotificationType = "INGESTION",
            Data = new
            {
                AccountId = accountId,
                Status = status.ToString(),
                Filepath = string.IsNullOrWhiteSpace(filepath) ? fileId : filepath
            }
        }, cancellationToken);

    public Task SendFeedbackRequiredAsync(string accountId, string feedbackRequestId, string sourceId,
        string markdownPath, CancellationToken cancellationToken) => SendToAccountAsync(accountId, oid => new
        {
            Oid = oid,
            NotificationType = "ALERT",
            Data = new
            {
                AccountId = accountId,
                Status = "FEEDBACK_REQUIRED",
                ClientFeedbackRequestId = feedbackRequestId,
                SourceId = sourceId,
                MarkdownPath = markdownPath
            }
        }, cancellationToken);

    private async Task SendToAccountAsync<T>(string accountId, Func<string, T> createNotice,
        CancellationToken cancellationToken)
    {
        var accountRecipients = await recipients.GetRecipientsAsync(accountId, cancellationToken);
        logger?.LogInformation("Sending account notification to {RecipientCount} recipients",
            accountRecipients.Count);
        foreach (var oid in accountRecipients)
            await client.SendAsync(createNotice(oid), cancellationToken);
    }
}
