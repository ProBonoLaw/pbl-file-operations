using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Azure.Core;
using Azure.Identity;

namespace FileOperations;

public sealed record GraphItem(string DriveId, string ListItemId, string Name,
    string Path, string? MediaType, string? ModifiedDate);

public sealed class SharePointGraph
{
    private readonly HttpClient client;
    private readonly TokenCredential credential;
    private readonly string graphUrl = Settings.Get("GRAPH_URL")
        ?? "https://graph.microsoft.com/v1.0";

    public SharePointGraph(HttpClient client)
        : this(client, new ClientSecretCredential(
            Settings.Required("SHAREPOINT_TENANT_ID"),
            Settings.Required("SHAREPOINT_CLIENT_ID"),
            Settings.Required("SHAREPOINT_CLIENT_SECRET"))) { }

    public SharePointGraph(HttpClient client, TokenCredential credential)
    {
        this.client = client;
        this.credential = credential;
    }

    public static string? DecodeConnectorPath(string identifier)
    {
        var decoded = identifier;
        for (var iteration = 0; iteration < 4; iteration++)
        {
            var next = Uri.UnescapeDataString(decoded);
            if (next == decoded) break;
            decoded = next;
        }
        decoded = decoded.Replace('+', ' ');
        foreach (var marker in new[] { "Shared Documents/", "Documents/" })
        {
            var index = decoded.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
            if (index >= 0 && (index == 0 || decoded[index - 1] == '/'))
                return decoded[(index + marker.Length)..];
        }
        return null;
    }

    public async Task<string> SiteIdAsync(string accountId, CancellationToken cancellationToken)
    {
        var host = Settings.Required("SHAREPOINT_HOST");
        var prefix = Settings.Get("SHAREPOINT_SITE_PREFIX") ?? "/sites";
        using var response = await RequestAsync(HttpMethod.Get,
            $"/sites/{host}:{prefix.TrimEnd('/')}/{Uri.EscapeDataString(accountId)}", null, cancellationToken);
        response.EnsureSuccessStatusCode();
        using var document = await JsonDocument.ParseAsync(
            await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        return document.RootElement.GetProperty("id").GetString()!;
    }

    public async Task<GraphItem> MetadataAsync(string siteId, string identifier,
        CancellationToken cancellationToken)
    {
        var mode = Settings.Get("SHAREPOINT_IDENTIFIER_MODE") ?? "connector";
        string path;
        if (mode == "drive_id")
            path = ItemPath(siteId, identifier);
        else
        {
            var relative = mode == "path" ? identifier : DecodeConnectorPath(identifier);
            if (relative is null)
                throw new InvalidDataException("SharePoint identifier is not a decodable Documents path");
            path = $"/sites/{Uri.EscapeDataString(siteId)}/drive/root:/{EscapePath(relative.TrimStart('/'))}";
        }
        using var response = await RequestAsync(HttpMethod.Get, path, null, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
            throw new FileNotFoundException("SharePoint file was not found");
        response.EnsureSuccessStatusCode();
        using var document = await JsonDocument.ParseAsync(
            await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        var item = document.RootElement;
        var driveId = item.GetProperty("id").GetString()!;
        string? listId = null;
        if (item.TryGetProperty("sharepointIds", out var ids) &&
            ids.TryGetProperty("listItemId", out var listItemId))
            listId = listItemId.GetString();
        if (string.IsNullOrEmpty(listId))
        {
            using var listResponse = await RequestAsync(HttpMethod.Get,
                ItemPath(siteId, driveId) + "/listItem", null, cancellationToken);
            listResponse.EnsureSuccessStatusCode();
            using var listDocument = await JsonDocument.ParseAsync(
                await listResponse.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            listId = listDocument.RootElement.GetProperty("id").GetString();
        }
        var name = item.GetProperty("name").GetString()!;
        var parent = item.GetProperty("parentReference").GetProperty("path").GetString() ?? "";
        var relativeParent = parent.Split("root:").Last().Trim('/');
        var filePath = "/Shared Documents/" + (relativeParent.Length > 0 ? relativeParent + "/" : "") + name;
        var mediaType = item.TryGetProperty("file", out var file) && file.TryGetProperty("mimeType", out var mime)
            ? mime.GetString() : null;
        var modified = item.TryGetProperty("lastModifiedDateTime", out var date) ? date.GetString() : null;
        return new GraphItem(driveId, listId!, name, filePath, mediaType, modified);
    }

    public async Task<string> SharingLinkAsync(string siteId, string driveId,
        CancellationToken cancellationToken)
    {
        using var response = await RequestAsync(HttpMethod.Post, ItemPath(siteId, driveId) + "/createLink",
            new StringContent("{\"type\":\"view\",\"scope\":\"anonymous\"}", Encoding.UTF8, "application/json"),
            cancellationToken);
        response.EnsureSuccessStatusCode();
        using var document = await JsonDocument.ParseAsync(
            await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        return document.RootElement.GetProperty("link").GetProperty("webUrl").GetString()!;
    }

    public async Task<HttpResponseMessage> ContentAsync(string siteId, string driveId,
        CancellationToken cancellationToken)
    {
        var response = await RequestAsync(HttpMethod.Get, ItemPath(siteId, driveId) + "/content",
            null, cancellationToken);
        response.EnsureSuccessStatusCode();
        return response;
    }

    public async Task<(string DriveId, string ListId)> UploadFeedbackAsync(
        string siteId, string folder, string filename, Stream markdown, long length,
        CancellationToken cancellationToken)
    {
        var drive = $"/sites/{Uri.EscapeDataString(siteId)}/drive";
        using var folderResponse = await RequestAsync(HttpMethod.Post,
            drive + "/root:/_GeneratedDocuments:/children",
            new StringContent(JsonSerializer.Serialize(new Dictionary<string, object>
            {
                ["name"] = folder, ["folder"] = new { },
                ["@microsoft.graph.conflictBehavior"] = "fail"
            }),
                Encoding.UTF8, "application/json"), cancellationToken);
        folderResponse.EnsureSuccessStatusCode();
        var filePath = drive + $"/root:/_GeneratedDocuments/{Uri.EscapeDataString(folder)}/{Uri.EscapeDataString(filename)}:";
        using var fileResponse = length <= 4 * 1024 * 1024
            ? await RequestAsync(HttpMethod.Put, filePath + "/content",
                new StreamContent(markdown), cancellationToken)
            : await UploadLargeFileAsync(filePath, markdown, length, filename, cancellationToken);
        fileResponse.EnsureSuccessStatusCode();
        using var document = await JsonDocument.ParseAsync(
            await fileResponse.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        var uploaded = document.RootElement;
        var driveId = uploaded.GetProperty("id").GetString()!;
        var listId = uploaded.TryGetProperty("sharepointIds", out var ids) &&
            ids.TryGetProperty("listItemId", out var id) ? id.GetString() : null;
        if (string.IsNullOrEmpty(listId))
        {
            using var listResponse = await RequestAsync(HttpMethod.Get,
                ItemPath(siteId, driveId) + "/listItem", null, cancellationToken);
            listResponse.EnsureSuccessStatusCode();
            using var listDocument = await JsonDocument.ParseAsync(
                await listResponse.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            listId = listDocument.RootElement.GetProperty("id").GetString();
        }
        return (driveId, listId!);
    }

    private async Task<HttpResponseMessage> UploadLargeFileAsync(string path, Stream content,
        long length, string filename, CancellationToken cancellationToken)
    {
        var sessionBody = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["item"] = new Dictionary<string, object>
            {
                ["name"] = filename, ["@microsoft.graph.conflictBehavior"] = "fail"
            }
        });
        using var sessionResponse = await RequestAsync(HttpMethod.Post, path + "/createUploadSession",
            new StringContent(sessionBody, Encoding.UTF8, "application/json"), cancellationToken);
        sessionResponse.EnsureSuccessStatusCode();
        using var session = await JsonDocument.ParseAsync(
            await sessionResponse.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        var uploadUrl = session.RootElement.GetProperty("uploadUrl").GetString()!;
        const int chunkSize = 320 * 1024 * 10;
        var buffer = new byte[chunkSize];
        long offset = 0;
        while (offset < length)
        {
            var size = (int)Math.Min(chunkSize, length - offset);
            await content.ReadExactlyAsync(buffer.AsMemory(0, size), cancellationToken);
            using var request = new HttpRequestMessage(HttpMethod.Put, uploadUrl)
            {
                Content = new ByteArrayContent(buffer, 0, size)
            };
            request.Content.Headers.ContentRange = new System.Net.Http.Headers.ContentRangeHeaderValue(
                offset, offset + size - 1, length);
            var response = await client.SendAsync(request, cancellationToken);
            response.EnsureSuccessStatusCode();
            offset += size;
            if (offset == length) return response;
            response.Dispose();
        }
        throw new InvalidDataException("Upload session ended without a file response");
    }

    private async Task<HttpResponseMessage> RequestAsync(HttpMethod method, string path,
        HttpContent? content, CancellationToken cancellationToken)
    {
        var token = await credential.GetTokenAsync(
            new TokenRequestContext(["https://graph.microsoft.com/.default"]), cancellationToken);
        using var request = new HttpRequestMessage(method, graphUrl + path) { Content = content };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
        return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
    }

    private static string ItemPath(string siteId, string driveId) =>
        $"/sites/{Uri.EscapeDataString(siteId)}/drive/items/{Uri.EscapeDataString(driveId)}";

    private static string EscapePath(string path) =>
        string.Join('/', path.Split('/', StringSplitOptions.RemoveEmptyEntries).Select(Uri.EscapeDataString));
}
