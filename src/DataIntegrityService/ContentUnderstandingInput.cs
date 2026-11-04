using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

/// <summary>Streams a private blob into the documented analysis data field without a public URL or buffering the file.</summary>
public sealed record ContentUnderstandingInput(long Length, string Name, string MimeType,
    Func<CancellationToken, Task<Stream>> OpenRead)
{
    public HttpContent CreateContent(string? modelDeployments) => new InputContent(this, modelDeployments);

    private sealed class InputContent : HttpContent
    {
        private readonly ContentUnderstandingInput input;
        private readonly byte[] prefix;
        private readonly byte[] suffix;

        public InputContent(ContentUnderstandingInput input, string? mappings)
        {
            if (input.Length < 0) throw new ArgumentOutOfRangeException(nameof(input));
            this.input = input;
            prefix = Encoding.UTF8.GetBytes("{\"inputs\":[{\"name\":" + JsonSerializer.Serialize(input.Name) +
                ",\"mimeType\":" + JsonSerializer.Serialize(input.MimeType) + ",\"data\":\"");
            string ending = "\"}]";
            if (!string.IsNullOrEmpty(mappings))
            {
                using var parsed = JsonDocument.Parse(mappings);
                if (parsed.RootElement.ValueKind != JsonValueKind.Object)
                    throw new InvalidDataException("CU model deployments must be an object.");
                ending += ",\"modelDeployments\":" + parsed.RootElement.GetRawText();
            }
            suffix = Encoding.UTF8.GetBytes(ending + "}");
            Headers.ContentType = new MediaTypeHeaderValue("application/json");
        }

        protected override bool TryComputeLength(out long length)
        {
            length = checked(prefix.LongLength + ((input.Length + 2) / 3) * 4 + suffix.LongLength);
            return true;
        }

        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
            SerializeToStreamAsync(stream, context, CancellationToken.None);

        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context, CancellationToken cancellationToken)
        {
            await stream.WriteAsync(prefix, cancellationToken);
            await using var source = await input.OpenRead(cancellationToken);
            using var transform = new ToBase64Transform();
            await using (var encoder = new CryptoStream(stream, transform, CryptoStreamMode.Write, leaveOpen: true))
            {
                var buffer = new byte[81920];
                long copied = 0;
                int read;
                while ((read = await source.ReadAsync(buffer, cancellationToken)) != 0)
                {
                    copied += read;
                    if (copied > input.Length) throw new InvalidDataException("CU source length changed.");
                    await encoder.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                }
                if (copied != input.Length) throw new InvalidDataException("CU source length changed.");
                await encoder.FlushFinalBlockAsync(cancellationToken);
            }
            await stream.WriteAsync(suffix, cancellationToken);
        }
    }
}
