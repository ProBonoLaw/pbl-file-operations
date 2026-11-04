using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Azure.Core.Pipeline;
using Azure.Data.Tables;
using Azure.Storage.Blobs;

namespace FileOperations.Tests;

// Exercise real Azure SDK reads/writes, including the partition selected by the flow.
internal sealed class ProgressStore : HttpMessageHandler
{
    private readonly HttpClient http;
    private readonly ConcurrentDictionary<(string Partition, string Row), TableEntity> rows = new();
    public ConcurrentQueue<string> Reads { get; } = new();
    public ConcurrentQueue<(string Partition, string Row)> Writes { get; } = new();
    public ConcurrentQueue<string> MarkerReads { get; } = new();
    public HashSet<string> Markers { get; } = [];
    public TableClient Client { get; }
    public BlobServiceClient Blobs { get; }

    public ProgressStore(params TableEntity[] initial)
    {
        foreach (var row in initial) rows[(row.PartitionKey, row.RowKey)] = row;
        http = new HttpClient(this, false);
        var transport = new HttpClientTransport(http);
        Client = new TableClient(new Uri("https://storage.example"), "IngestionProgress",
            new TableSharedKeyCredential("storage", Convert.ToBase64String(new byte[32])),
            new TableClientOptions { Transport = transport, Retry = { MaxRetries = 0 } });
        Blobs = new BlobServiceClient(new Uri("https://blob.example"),
            new BlobClientOptions { Transport = transport, Retry = { MaxRetries = 0 } });
    }

    public TableEntity Row(string partition, string row) => rows[(partition, row)];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        var path = Uri.UnescapeDataString(request.RequestUri!.AbsolutePath);
        if (request.RequestUri.Host == "blob.example")
        {
            if (request.Method == HttpMethod.Head)
            {
                MarkerReads.Enqueue(path);
                if (Markers.Contains(path)) return Reply(HttpStatusCode.OK);
                var missing = Reply(HttpStatusCode.NotFound);
                missing.Headers.TryAddWithoutValidation("x-ms-error-code", "BlobNotFound");
                return missing;
            }
            throw new InvalidOperationException("Unexpected blob operation: " + request.Method);
        }

        var match = Regex.Match(path, @"\(PartitionKey='(.*)',RowKey='(.*)'\)$");
        if (!match.Success) throw new InvalidOperationException("Unexpected table path: " + path);
        var key = (Partition: match.Groups[1].Value, Row: match.Groups[2].Value);
        if (request.Method == HttpMethod.Get)
        {
            Reads.Enqueue(path);
            return rows.TryGetValue(key, out var entity)
                ? Reply(HttpStatusCode.OK, JsonSerializer.Serialize(new Dictionary<string, object>(entity)
                    { ["odata.etag"] = "W/\"test\"" }))
                : Reply(HttpStatusCode.NotFound,
                    """{"odata.error":{"code":"ResourceNotFound","message":{"lang":"en-US","value":"Not found"}}}""");
        }
        if (request.Method.Method is "PATCH" or "MERGE" or "PUT")
        {
            Writes.Enqueue(key);
            var entity = rows.GetOrAdd(key, _ => new TableEntity(key.Partition, key.Row));
            using var document = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            foreach (var property in document.RootElement.EnumerateObject())
            {
                if (property.Name.Contains('@') || property.Name is "PartitionKey" or "RowKey" or "Timestamp") continue;
                entity[property.Name] = property.Value.ValueKind switch
                {
                    JsonValueKind.String => property.Value.GetString(),
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    JsonValueKind.Number => property.Value.GetInt64(),
                    _ => throw new InvalidOperationException("Unexpected table value")
                };
            }
            entity.Timestamp = DateTimeOffset.UtcNow;
            return Reply(HttpStatusCode.NoContent);
        }
        throw new InvalidOperationException("Unexpected table operation: " + request.Method);
    }

    private static HttpResponseMessage Reply(HttpStatusCode status, string body = "")
    {
        var response = new HttpResponseMessage(status)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        };
        response.Headers.TryAddWithoutValidation("ETag", "\"test\"");
        response.Headers.TryAddWithoutValidation("x-ms-blob-type", "BlockBlob");
        response.Content.Headers.LastModified = DateTimeOffset.UtcNow;
        return response;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) http.Dispose();
        base.Dispose(disposing);
    }
}
