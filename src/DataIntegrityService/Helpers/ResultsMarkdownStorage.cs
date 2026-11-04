using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Azure.Storage.Blobs;
using DaatPhoenix.DaatLaw.AI.DataIntegrity.Models.AzureFunctions.Models;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration.Helpers
{
	/// <summary>
	/// Stores generated Markdown in the configured results container.
	/// </summary>
	internal static class ResultsMarkdownStorage
	{
		public static async Task<string> StoreAsync(
			BlobServiceClient blobServiceClient,
			string outputContainer,
			string content,
			DocumentRequest request,
			CancellationToken cancellationToken,
			string extractionIdentity = "")
		{
			string outputFileName = NameHelper.GenerateTempFileName(request, extractionIdentity);
			BlobClient blobClient = blobServiceClient
				.GetBlobContainerClient(outputContainer)
				.GetBlobClient(outputFileName);

			if (await blobClient.ExistsAsync(cancellationToken))
			{
				if (request.Force != true)
				{
					return outputFileName;
				}
				await blobClient.DeleteAsync(cancellationToken: cancellationToken);
			}

			byte[] encoded = Encoding.UTF8.GetBytes(content);
			using var stream = new MemoryStream(encoded);
			await blobClient.UploadAsync(stream, cancellationToken);
			return outputFileName;
		}
	}
}
