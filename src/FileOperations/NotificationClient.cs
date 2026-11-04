using System.Net;

namespace FileOperations;

public enum IngestionStatus
{
    STARTED,
    SUCCESS,
    FAILED,
    PRELIMINARY,
    EVIDENCE_EXTRACTION
}

/// <summary>Transport for the notification service's /api/sendNotice JSON contract.</summary>
public sealed class NotificationClient(HttpClient httpClient)
{
    public async Task SendAsync<T>(T notice, CancellationToken cancellationToken = default)
    {
        // A rejected request may already have persisted a notice. Never retry here.
        using var response = await httpClient.PostAsJsonAsync("api/sendNotice", notice, cancellationToken);
        if (response.StatusCode != HttpStatusCode.Accepted)
            throw new NotificationTransmissionException(response.StatusCode,
                await response.Content.ReadAsStringAsync(cancellationToken));
    }
}

public sealed class NotificationTransmissionException(HttpStatusCode statusCode, string responseBody)
    : HttpRequestException($"Notification service rejected the request with HTTP {(int)statusCode}.",
        null, statusCode)
{
    public string ResponseBody { get; } = responseBody;
}
