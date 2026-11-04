using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Azure;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

public sealed record CuImageReference(string Id, string Kind, string ServiceFilePath,
    IReadOnlyList<string> BlockIds, IReadOnlyList<int> Pages, IReadOnlyList<string> Regions, long? TimeMs = null);

public static class ContentUnderstandingAssets
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    public static IReadOnlyList<CuImageReference> Discover(ExtractionPackage package)
    {
        var references = new List<CuImageReference>();
        int index = 0;
        foreach (var content in package.RawResponse.GetProperty("result").GetProperty("contents").EnumerateArray())
        {
            if (content.TryGetProperty("figures", out var figures))
            foreach (var figure in figures.EnumerateArray())
            {
                string id = figure.GetProperty("id").GetString() ?? throw new InvalidDataException("CU figure has no image ID.");
                int offset = figure.GetProperty("span").GetProperty("offset").GetInt32();
                int length = figure.GetProperty("span").GetProperty("length").GetInt32();
                // Empty figure spans have no text overlap. Bind the image to its own
                // figure block, rather than nearby OCR or another figure at that offset.
                var blocks = package.Blocks.Where(b => length == 0
                    ? b.Id == $"{index}:figure-id:{id}"
                    : b.ServiceSpans.Any(s => s.ContentIndex == index && s.Length > 0 &&
                        s.Offset < (long)offset + length && offset < (long)s.Offset + s.Length)).ToArray();
                references.Add(new($"figure:{index}:{id}", "figure", "figures/" + id,
                    blocks.Select(b => b.Id).ToArray(), blocks.SelectMany(b => b.Pages).Distinct().Order().ToArray(),
                    blocks.SelectMany(b => b.Regions).Distinct().ToArray()));
            }
            index++;
        }
        foreach (var time in package.Blocks.Where(b => b.Kind == "keyframes").SelectMany(b => b.KeyFrameTimesMs ?? []).Distinct().Order())
        {
            var blocks = package.Blocks.Where(b => b.StartTimeMs <= time && b.EndTimeMs >= time).ToArray();
            references.Add(new($"keyframe:{time}", "keyframe", "keyframes/" + time.ToString(CultureInfo.InvariantCulture),
                blocks.Select(b => b.Id).ToArray(), [], [], time));
        }
        return references;
    }

    public static async Task<ExtractionPackage> RetainAsync(ExtractionPackage package, string operation,
        ContentUnderstandingClient client, BlobContainerClient container, CancellationToken cancellationToken)
    {
        var assets = new List<ExtractionAsset>();
        var references = Discover(package);
        if (references.Count == 0) return package with { Assets = assets };
        string accountHash = Hash(package.AccountId), sourceHash = Hash(package.SourceId);
        string prefix = $"cu-assets/{accountHash}/{sourceHash}/{package.AnalysisId}/";
        var receipt = container.GetBlobClient(prefix + "images.json");
        var cached = await receipt.ExistsAsync(cancellationToken)
            ? (await receipt.DownloadContentAsync(cancellationToken)).Value.Content.ToObjectFromJson<ExtractionAsset[]>(JsonOptions) ?? []
            : [];
        foreach (var reference in references)
        {
            var retained = cached.SingleOrDefault(asset => asset.ServiceFilePath == reference.ServiceFilePath);
            if (retained is not null && await container.GetBlobClient(retained.ContainerPath).ExistsAsync(cancellationToken))
            {
                assets.Add(retained with { Id = reference.Id, BlockIds = reference.BlockIds, Pages = reference.Pages,
                    Regions = reference.Regions, TimeMs = reference.TimeMs });
                continue;
            }
            var (bytes, contentType) = await client.GetImageAsync(operation, reference.ServiceFilePath, cancellationToken);
            string hash = Convert.ToHexStringLower(SHA256.HashData(bytes));
            string extension = contentType switch { "image/jpeg" => "jpg", "image/png" => "png", "image/gif" => "gif", _ => "webp" };
            string path = prefix + hash + "." + extension;
            try
            {
                await container.GetBlobClient(path).UploadAsync(BinaryData.FromBytes(bytes), new BlobUploadOptions
                {
                    Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All },
                    HttpHeaders = new BlobHttpHeaders { ContentType = contentType }
                }, cancellationToken);
            }
            catch (RequestFailedException error) when (error.Status is 409 or 412) { }
            assets.Add(new(reference.Id, reference.Kind, container.Name, path, contentType, hash, bytes.LongLength,
                reference.ServiceFilePath, reference.BlockIds, reference.Pages, reference.Regions,
                container.GetBlobClient(path).Uri.AbsoluteUri, reference.TimeMs));
            // Persist each retained file so interrupted jobs resume without relying
            // on the lifetime of the CU result-file API.
            await receipt.UploadAsync(BinaryData.FromObjectAsJson(assets, JsonOptions), overwrite: true, cancellationToken);
        }
        return package with { Assets = assets };
    }

    public static string Markdown(ExtractionPackage package, string filename)
    {
        var text = new StringBuilder($"# {filename}\n\nAnalysis ID: {package.AnalysisId}\n\n");
        var included = new HashSet<string>();
        foreach (var block in package.Blocks)
        {
            text.Append(block.Origin == "generated" ? $"## AI-generated {block.Kind}\n{block.Text}" :
                block.StartTimeMs is { } start ? $"[{TimeSpan.FromMilliseconds(start):c}–{TimeSpan.FromMilliseconds(block.EndTimeMs!.Value):c}] {block.Speaker}: {block.Text}" : block.Text);
            foreach (var asset in (package.Assets ?? []).Where(a => a.BlockIds.Contains(block.Id) && included.Add(a.Id)))
                text.Append($"\n\n![{asset.Kind}{(asset.TimeMs is { } time ? $" at {time} ms" : "")}]({asset.Url})");
            text.Append("\n\n");
        }
        return text.ToString();
    }

    private static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
