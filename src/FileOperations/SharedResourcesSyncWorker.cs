using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Producer;
using Microsoft.ApplicationInsights;
using Microsoft.Azure.Cosmos;
using Newtonsoft.Json.Linq;

namespace FileOperations;

public sealed class SharePointGraphAuthorizationException(HttpStatusCode statusCode)
    : Exception($"Microsoft Graph returned HTTP {(int)statusCode} while accessing SharePoint")
{
    public HttpStatusCode StatusCode { get; } = statusCode;
}

public sealed record SharePointChangeBatch(IReadOnlyList<JsonElement> Changes, string DeltaLink);

public sealed class SharePointChangeFeed
{
    private readonly HttpClient client;
    private readonly TokenCredential credential;
    private readonly string host;
    private readonly string sitePrefix;
    private readonly string graphUrl;
    private readonly Uri graphBaseUri;

    public SharePointChangeFeed(HttpClient client, TokenCredential credential)
    {
        this.client = client;
        this.credential = credential;
        host = Settings.Required("SHAREPOINT_HOST");
        sitePrefix = Settings.Get("SHAREPOINT_SITE_PREFIX") ?? "/sites";
        var configuredGraphUrl = Settings.Get("GRAPH_URL") ?? "https://graph.microsoft.com/v1.0";
        if (!Uri.TryCreate(configuredGraphUrl, UriKind.Absolute, out var configuredGraphUri) ||
            configuredGraphUri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("GRAPH_URL must be an absolute HTTPS URL");
        graphBaseUri = configuredGraphUri;
        graphUrl = configuredGraphUri.AbsoluteUri.TrimEnd('/');
    }

    public async Task<SharePointChangeBatch?> GetChangesAsync(string accountId,
        string? deltaLink, CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(deltaLink))
            return await ReadDeltaAsync(accountId, deltaLink, true, cancellationToken);

        var siteUrl = new Uri($"{graphUrl}/sites/{host}:{sitePrefix.TrimEnd('/')}/{Uri.EscapeDataString(accountId)}");
        using var siteResponse = await SendAsync(HttpMethod.Get, siteUrl, cancellationToken);
        if (siteResponse.StatusCode == HttpStatusCode.NotFound) return null;
        siteResponse.EnsureSuccessStatusCode();
        using var site = await JsonDocument.ParseAsync(
            await siteResponse.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        var siteId = site.RootElement.GetProperty("id").GetString();
        if (string.IsNullOrWhiteSpace(siteId))
            throw new InvalidDataException("SharePoint site returned no Graph site ID");

        var filter = Uri.EscapeDataString("displayName eq 'Documents'");
        var listsUrl = new Uri(
            $"{graphUrl}/sites/{Uri.EscapeDataString(siteId)}/lists?$filter={filter}&$select=id,displayName");
        using var listsResponse = await SendAsync(HttpMethod.Get, listsUrl, cancellationToken);
        if (listsResponse.StatusCode == HttpStatusCode.NotFound) return null;
        listsResponse.EnsureSuccessStatusCode();
        using var lists = await JsonDocument.ParseAsync(
            await listsResponse.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        var listId = lists.RootElement.GetProperty("value").EnumerateArray()
            .FirstOrDefault(list => list.TryGetProperty("displayName", out var name) &&
                string.Equals(name.GetString(), "Documents", StringComparison.OrdinalIgnoreCase));
        if (listId.ValueKind == JsonValueKind.Undefined) return null;
        var id = listId.GetProperty("id").GetString();
        if (string.IsNullOrWhiteSpace(id))
            throw new InvalidDataException("SharePoint Documents list returned no Graph list ID");

        var initialDeltaUrl = new Uri(
            $"{graphUrl}/sites/{Uri.EscapeDataString(siteId)}/lists/{Uri.EscapeDataString(id)}/items/delta");
        return await ReadDeltaAsync(accountId, initialDeltaUrl.AbsoluteUri, false, cancellationToken);
    }

    private async Task<SharePointChangeBatch?> ReadDeltaAsync(string accountId, string firstPageUrl,
        bool isSavedDeltaLink, CancellationToken cancellationToken)
    {
        var changes = new List<JsonElement>();
        var pageUrl = firstPageUrl;
        while (true)
        {
            using var response = await SendAsync(HttpMethod.Get, GraphUri(pageUrl), cancellationToken);
            if (isSavedDeltaLink && response.StatusCode is HttpStatusCode.Gone or HttpStatusCode.NotFound)
                return await GetChangesAsync(accountId, null, cancellationToken);
            if (response.StatusCode == HttpStatusCode.NotFound) return null;
            response.EnsureSuccessStatusCode();
            using var page = await JsonDocument.ParseAsync(
                await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            var root = page.RootElement;
            if (!root.TryGetProperty("value", out var values) || values.ValueKind != JsonValueKind.Array)
                throw new InvalidDataException("Graph delta response has no value array");
            changes.AddRange(values.EnumerateArray().Select(change => change.Clone()));

            if (root.TryGetProperty("@odata.nextLink", out var nextLink) &&
                !string.IsNullOrWhiteSpace(nextLink.GetString()))
            {
                pageUrl = nextLink.GetString()!;
                continue;
            }
            if (!root.TryGetProperty("@odata.deltaLink", out var deltaLink) ||
                string.IsNullOrWhiteSpace(deltaLink.GetString()))
                throw new InvalidDataException("Graph delta response has no delta link");
            return new SharePointChangeBatch(changes, deltaLink.GetString()!);
        }
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, Uri uri,
        CancellationToken cancellationToken)
    {
        var token = await credential.GetTokenAsync(
            new TokenRequestContext([$"{graphBaseUri.GetLeftPart(UriPartial.Authority)}/.default"]),
            cancellationToken);
        using var request = new HttpRequestMessage(method, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
        request.Headers.Accept.ParseAdd("application/json");
        var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            var status = response.StatusCode;
            response.Dispose();
            throw new SharePointGraphAuthorizationException(status);
        }
        return response;
    }

    private Uri GraphUri(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            uri.Scheme != Uri.UriSchemeHttps ||
            !string.Equals(uri.Host, graphBaseUri.Host, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Graph delta returned an invalid continuation URL");
        return uri;
    }
}

public sealed class SharedResourcesSyncWorker(
    CosmosClient cosmos,
    SharedResourceSyncStateStore stateStore,
    SharePointChangeFeed changeFeed,
    EventHubProducerClient producer,
    TelemetryClient telemetry,
    IHostApplicationLifetime lifetime,
    ILogger<SharedResourcesSyncWorker> logger) : BackgroundService
{
    private const string RootAccountId = "00000000-0000-0000-0000-000000000000";
    private readonly Container accounts = cosmos.GetContainer(
        Settings.Get("COSMOS_DATABASE") ?? "db_conversation_history", "accounts");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var stopwatch = Stopwatch.StartNew();
        var dispatchSummary = new DispatchSummary();
        try
        {
            await stateStore.EnsureReadyAsync(stoppingToken);
            var accountIds = await GetSharedAccountIdsAsync(stoppingToken);
            var failed = 0;
            await Parallel.ForEachAsync(accountIds,
                new ParallelOptions { MaxDegreeOfParallelism = 5, CancellationToken = stoppingToken },
                async (accountId, cancellationToken) =>
                {
                    using var accountScope = logger.BeginScope(new Dictionary<string, object?>
                    {
                        ["accountId"] = accountId
                    });
                    try
                    {
                        await SynchronizeAccountAsync(accountId, dispatchSummary, cancellationToken);
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (Exception error) when (!IsInfrastructureFailure(error))
                    {
                        Interlocked.Increment(ref failed);
                        logger.LogWarning("Shared-resource sync deferred until the next run ({ErrorType})",
                            error.GetType().Name);
                    }
                });
            telemetry.TrackEvent("SharedResourceSyncCycle", new Dictionary<string, string>
            {
                ["outcome"] = failed == 0 ? "Succeeded" : "PartialFailure",
                ["accounts"] = accountIds.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["failedAccounts"] = failed.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["durationMs"] = stopwatch.Elapsed.TotalMilliseconds.ToString("F1",
                    System.Globalization.CultureInfo.InvariantCulture)
            });
            logger.LogInformation("Shared-resource sync run completed for {AccountCount} accounts; {FailedCount} deferred",
                accountIds.Count, failed);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            telemetry.TrackEvent("SharedResourceSyncCycle", new Dictionary<string, string>
            {
                ["outcome"] = "InfrastructureFailed",
                ["errorType"] = error.GetType().Name,
                ["durationMs"] = stopwatch.Elapsed.TotalMilliseconds.ToString("F1",
                    System.Globalization.CultureInfo.InvariantCulture)
            });
            var sharePointStatusCode = error is SharePointGraphAuthorizationException authorizationError
                ? (int)authorizationError.StatusCode
                : (int?)null;
            logger.LogCritical(
                "Shared-resource sync cannot access a required resource ({ErrorType}); SharePointStatusCode={SharePointStatusCode}",
                error.GetType().Name, sharePointStatusCode);
            Environment.ExitCode = 1;
        }
        finally
        {
            logger.LogInformation(
                "Shared-resource sync dispatched {IngestionCount} create/update events and {DeletionCount} delete events in {DurationMs} ms",
                dispatchSummary.IngestionCount, dispatchSummary.DeletionCount,
                stopwatch.Elapsed.TotalMilliseconds);
            // This process exits after one run, so give queued telemetry time to send.
            telemetry.Flush();
            await Task.Delay(TimeSpan.FromSeconds(5));
            lifetime.StopApplication();
        }
    }

    private async Task<IReadOnlyList<string>> GetSharedAccountIdsAsync(CancellationToken cancellationToken)
    {
        var query = new QueryDefinition("SELECT * FROM c");
        using var iterator = accounts.GetItemQueryIterator<JObject>(query,
            requestOptions: new QueryRequestOptions { PartitionKey = new PartitionKey(RootAccountId) });
        var accountIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (iterator.HasMoreResults)
        {
            var page = await iterator.ReadNextAsync(cancellationToken);
            foreach (var userAccount in page)
            {
                if (userAccount["casesAccounts"] is not JArray sharedAccounts) continue;
                foreach (var sharedAccount in sharedAccounts.OfType<JObject>())
                {
                    if (sharedAccount.Value<bool?>("isGuest") == true) continue;
                    var accountId = sharedAccount.Value<string>("accountId");
                    if (!string.IsNullOrWhiteSpace(accountId)) accountIds.Add(accountId);
                }
            }
        }
        return accountIds.ToArray();
    }

    private async Task SynchronizeAccountAsync(string accountId, DispatchSummary dispatchSummary,
        CancellationToken cancellationToken)
    {
        var query = new QueryDefinition("SELECT TOP 1 * FROM c WHERE c.type = @type")
            .WithParameter("@type", "ACCOUNT_DETAILS");
        using var iterator = accounts.GetItemQueryIterator<JObject>(query,
            requestOptions: new QueryRequestOptions { PartitionKey = new PartitionKey(accountId) });
        JObject? accountDetails = null;
        while (iterator.HasMoreResults && accountDetails is null)
        {
            var page = await iterator.ReadNextAsync(cancellationToken);
            accountDetails = page.FirstOrDefault();
        }
        if (accountDetails is null)
        {
            logger.LogInformation("Skipping shared-resource sync because account details are missing");
            return;
        }

        var storedState = await stateStore.ReadAsync(accountId, cancellationToken);
        var previousToken = storedState?.State.DeltaLink ??
            accountDetails.Value<string>("fileOperationsGraphDeltaLink");
        var changes = await changeFeed.GetChangesAsync(accountId, previousToken, cancellationToken);
        if (changes is null) return;

        var previousFolders = storedState is not null
            ? storedState.State.FolderIds.ToHashSet(StringComparer.Ordinal)
            : accountDetails["fileOperationsGraphFolderIds"] is JArray savedFolders
                ? savedFolders.Values<string>().Where(folderId => !string.IsNullOrWhiteSpace(folderId))
                    .Select(folderId => folderId!).ToHashSet(StringComparer.Ordinal)
                : new HashSet<string>(StringComparer.Ordinal);
        var folderIds = new HashSet<string>(previousFolders, StringComparer.Ordinal);
        foreach (var change in changes.Changes)
        {
            var changedItemId = ReadStringOrNumber(change, "id");
            if (string.IsNullOrWhiteSpace(changedItemId))
                throw new InvalidDataException("Graph delta item has no ID");
            var isDeleted = IsDeleted(change);
            var isFolder = IsFolder(change) || (isDeleted && folderIds.Contains(changedItemId));
            if (isDeleted)
            {
                if (!long.TryParse(changedItemId, System.Globalization.NumberStyles.Integer,
                    System.Globalization.CultureInfo.InvariantCulture, out var numericId))
                    throw new InvalidDataException("Graph deletion change has an invalid list item ID");
                folderIds.Remove(changedItemId);
                await PublishAsync(new
                {
                    accountId,
                    id = numericId,
                    isFolder,
                    eventKind = "FileDeletion"
                }, "FileDeletion", accountId, changedItemId, dispatchSummary, cancellationToken);
            }
            else
            {
                if (isFolder) folderIds.Add(changedItemId);
                else folderIds.Remove(changedItemId);
                var identifier = ReadStringOrNumber(change, "webUrl");
                if (string.IsNullOrWhiteSpace(identifier))
                    throw new InvalidDataException("Graph delta item has no web URL");
                await PublishAsync(new
                {
                    accountId,
                    identifier,
                    isFolder,
                    eventKind = "FileIngestion"
                }, "FileIngestion", accountId, changedItemId, dispatchSummary, cancellationToken);
            }
        }

        if (storedState is null || changes.DeltaLink != previousToken || !folderIds.SetEquals(previousFolders))
        {
            await stateStore.SaveAsync(accountId, new SharedResourceSyncState(changes.DeltaLink,
                    folderIds.OrderBy(folderId => folderId, StringComparer.Ordinal).ToArray()),
                storedState?.ETag, cancellationToken);
        }

        logger.LogInformation(
            "Shared-resource sync completed for account {AccountId}",
             accountId);
    }

    private async Task PublishAsync(object content, string eventKind, string accountId, string sourceId,
        DispatchSummary dispatchSummary,
        CancellationToken cancellationToken)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(new { contentData = content },
            new JsonSerializerOptions { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull });
        var options = new SendEventOptions
        {
            PartitionKey = EventPartitioning.ForSource(accountId, sourceId)
        };
        await producer.SendAsync([new EventData(BinaryData.FromBytes(body))], options, cancellationToken);
        dispatchSummary.Record(eventKind);
        telemetry.TrackEvent("SharedResourceChangePublished",
            new Dictionary<string, string> { ["eventKind"] = eventKind });
    }

    private sealed class DispatchSummary
    {
        private long ingestionCount;
        private long deletionCount;

        public long IngestionCount => Interlocked.Read(ref ingestionCount);
        public long DeletionCount => Interlocked.Read(ref deletionCount);

        public void Record(string eventKind)
        {
            if (eventKind == "FileIngestion") Interlocked.Increment(ref ingestionCount);
            else if (eventKind == "FileDeletion") Interlocked.Increment(ref deletionCount);
        }
    }

    private static bool IsInfrastructureFailure(Exception error) => error switch
    {
        MissingSettingException or SharePointGraphAuthorizationException or AuthenticationFailedException or
            CosmosException or RequestFailedException or EventHubsException => true,
        _ => false
    };

    private static string? ReadStringOrNumber(JsonElement parent, string name) =>
        parent.TryGetProperty(name, out var value) ? ReadStringOrNumber(value) : null;

    private static string? ReadStringOrNumber(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString(),
        JsonValueKind.Number => value.GetRawText(),
        _ => null
    };

    private static bool IsDeleted(JsonElement change) =>
        change.TryGetProperty("deleted", out _) || change.TryGetProperty("@removed", out _);

    private static bool IsFolder(JsonElement change)
    {
        if (change.TryGetProperty("contentType", out var contentType))
        {
            if (contentType.TryGetProperty("name", out var name) &&
                string.Equals(name.GetString(), "Folder", StringComparison.OrdinalIgnoreCase))
                return true;
            if (contentType.TryGetProperty("id", out var id) &&
                id.GetString()?.StartsWith("0x0120", StringComparison.OrdinalIgnoreCase) == true)
                return true;
        }
        if (change.TryGetProperty("fields", out var fields) &&
            fields.TryGetProperty("FSObjType", out var objectType))
            return objectType.ValueKind == JsonValueKind.Number && objectType.TryGetInt32(out var number) && number == 1;
        return false;
    }
}
