using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Azure;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Azure.Storage.Blobs.Specialized;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration.Helpers;
using Microsoft.Extensions.Configuration;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

public sealed class ContentUnderstandingActivity(BlobServiceClient blobs, IConfiguration configuration,
    IHttpClientFactory httpClients, ExtractionPolicy policy, DataIntegrityOptions integrityOptions)
{
    public async Task<DocumentResponse> RunAsync(DocumentRequest request, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.ContainerName) || string.IsNullOrWhiteSpace(request.ContainerPath))
            throw new ArgumentException("CU conversion requires a source blob.");
        var options = ContentUnderstandingOptions.Read(configuration);
        string media = ExtractionPolicy.MediaType(request.Filename, request.FilePath) ?? "document";
        var source = blobs.GetBlobContainerClient(request.ContainerName).GetBlobClient(request.ContainerPath);
        var properties = await source.GetPropertiesAsync(cancellationToken: cancellationToken);
        long maxBytes = media switch { "video" => 4L * 1024 * 1024 * 1024, "audio" => 1024L * 1024 * 1024, _ => 200L * 1024 * 1024 };
        if (properties.Value.ContentLength > maxBytes) throw new InvalidDataException($"Source exceeds CU's {media} size limit.");
        // Hash the ETag-bound source before allocating a snapshot, so retries can find and lease the same journal.
        var download = await source.DownloadStreamingAsync(new BlobDownloadOptions
            { Conditions = new BlobRequestConditions { IfMatch = properties.Value.ETag } }, cancellationToken);
        string sourceHash;
        await using (var stream = download.Value.Content)
            sourceHash = Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, cancellationToken));
        string identity = policy.CacheIdentity(request);
        string operationKey = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"{request.AccountId}|{request.SourceId}|{sourceHash}|{identity}")));
        var journal = blobs.GetBlobContainerClient(integrityOptions.OutputContainer).GetBlobClient($"cu-operations/{operationKey}.json");
        try { await journal.UploadAsync(BinaryData.FromString("null"), overwrite: false, cancellationToken); }
        catch (RequestFailedException error) when (error.Status == 409) { }
        var lease = journal.GetBlobLeaseClient();
        await lease.AcquireAsync(TimeSpan.FromSeconds(60), cancellationToken: cancellationToken);
        using var leaseCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var renewal = RenewAsync(lease, leaseCancellation);
        var store = new BlobCuOperationStore(journal, lease.LeaseId);
        try
        {
            var prepared = await ContentUnderstandingSnapshots.PrepareAsync(blobs, store, request, sourceHash,
                properties.Value.ETag, leaseCancellation.Token);
            ContentUnderstandingInput? privateInput = null;
            if (prepared.Phase == "prepared")
            {
                var receipt = prepared.Source!;
                source = blobs.GetBlobContainerClient(receipt.ContainerName).GetBlobClient(receipt.ContainerPath).WithSnapshot(receipt.Snapshot);
                var snapshotProperties = await source.GetPropertiesAsync(cancellationToken: leaseCancellation.Token);
                privateInput = new(snapshotProperties.Value.ContentLength, request.Filename ?? "input",
                    snapshotProperties.Value.ContentType ?? "application/octet-stream", async token =>
                        (await source.DownloadStreamingAsync(new BlobDownloadOptions
                        {
                            Conditions = new BlobRequestConditions { IfMatch = snapshotProperties.Value.ETag }
                        }, token)).Value.Content);
            }
            var client = new ContentUnderstandingClient(httpClients.CreateClient("content-understanding"), options);
            var response = await client.AnalyzeAsync(options.Analyzer(media), "", store, leaseCancellation.Token, privateInput);
            var state = await store.ReadAsync(leaseCancellation.Token);
            string analysisId = new Uri(state!.Operation!).Segments.Last();
            var package = ContentUnderstandingAdapter.Convert(response, request, media, options.Analyzer(media), analysisId, identity, sourceHash);
            if (request.Rendition is { } rendition && rendition.PdfSha256 != sourceHash)
                throw new InvalidDataException("Analyzed PDF differs from the recorded Office rendition.");
            string filename = NameHelper.GenerateTempFileName(request, identity);
            string packagePath = filename + ".extraction.json";
            var container = blobs.GetBlobContainerClient(integrityOptions.OutputContainer);
            package = await ContentUnderstandingAssets.RetainAsync(package, state.Operation!, client, container, leaseCancellation.Token);
            // Raw output and package are persisted before the Markdown compatibility artifact.
            await container.GetBlobClient(packagePath).UploadAsync(BinaryData.FromObjectAsJson(package, new JsonSerializerOptions(JsonSerializerDefaults.Web)),
                overwrite: true, leaseCancellation.Token);
            var markdown = ContentUnderstandingAssets.Markdown(package, request.Filename);
            await container.GetBlobClient(filename).UploadAsync(BinaryData.FromString(markdown), overwrite: true, leaseCancellation.Token);
            return new(integrityOptions.OutputContainer, filename, packagePath, analysisId);
        }
        finally
        {
            // Use a separate deadline so request cancellation cannot skip terminal snapshot cleanup.
            try
            {
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                try
                {
                    // A canceled caller also stops the renewer. Reconfirm ownership before any snapshot deletion.
                    await lease.RenewAsync(cancellationToken: cleanup.Token);
                    await ContentUnderstandingSnapshots.CleanupAsync(blobs, store, cleanup.Token);
                }
                catch (Exception) { /* The journal receipt remains pending for the cleanup worker. */ }
            }
            finally
            {
                await leaseCancellation.CancelAsync();
                try { await renewal; } catch (OperationCanceledException) { }
                finally
                {
                    using var release = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                    await lease.ReleaseAsync(cancellationToken: release.Token);
                }
            }
        }
    }

    private static async Task RenewAsync(BlobLeaseClient lease, CancellationTokenSource cancellation)
    {
        try
        {
            while (true)
            {
                await Task.Delay(TimeSpan.FromSeconds(25), cancellation.Token);
                await lease.RenewAsync(cancellationToken: cancellation.Token);
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch { await cancellation.CancelAsync(); throw; }
    }
}

internal sealed class BlobCuOperationStore(BlobClient blob, string leaseId) : ICuOperationStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    public async Task<CuOperation?> ReadAsync(CancellationToken cancellationToken) =>
        JsonSerializer.Deserialize<CuOperation>((await blob.DownloadContentAsync(cancellationToken)).Value.Content, JsonOptions);
    public async Task SaveAsync(CuOperation operation, CancellationToken cancellationToken)
    {
        await blob.UploadAsync(BinaryData.FromObjectAsJson(operation, JsonOptions), new BlobUploadOptions
            { Conditions = new BlobRequestConditions { LeaseId = leaseId }, HttpHeaders = new BlobHttpHeaders { ContentType = "application/json" },
                Metadata = new Dictionary<string, string> { ["cuSnapshotPending"] = operation.Source is null ? "false" : "true" } }, cancellationToken);
    }
}
