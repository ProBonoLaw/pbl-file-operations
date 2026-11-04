using System.Text.Json;
using DaatPhoenix.DataLaw.DataIntegrity.Orchestration;
using Xunit;

namespace FileOperations.Tests;

public class ContentUnderstandingInputTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(81923)]
    public async Task StreamsExactBytesAndPreservesModelMappings(int size)
    {
        byte[] bytes = new byte[size];
        new Random(42).NextBytes(bytes);
        bool opened = false;
        var input = new ContentUnderstandingInput(size, "quote\".pdf", "application/pdf", _ =>
        {
            opened = true;
            return Task.FromResult<Stream>(new MemoryStream(bytes));
        });
        using var content = input.CreateContent("{\"model\":\"deployment\"}");
        Assert.False(opened);
        byte[] actual = await content.ReadAsByteArrayAsync();
        Assert.Equal(actual.LongLength, content.Headers.ContentLength);
        using var parsed = JsonDocument.Parse(actual);
        var file = parsed.RootElement.GetProperty("inputs")[0];
        Assert.Equal(bytes, file.GetProperty("data").GetBytesFromBase64());
        Assert.Equal("quote\".pdf", file.GetProperty("name").GetString());
        Assert.False(file.TryGetProperty("url", out _));
        Assert.Equal("deployment", parsed.RootElement.GetProperty("modelDeployments").GetProperty("model").GetString());
    }

    [Theory]
    [InlineData(1)]
    [InlineData(3)]
    public async Task RejectsSourceLengthChanges(long declaredLength)
    {
        var input = new ContentUnderstandingInput(declaredLength, "test", "text/plain",
            _ => Task.FromResult<Stream>(new MemoryStream(new byte[2])));
        using var content = input.CreateContent(null);
        var error = await Record.ExceptionAsync(() => content.CopyToAsync(Stream.Null));
        Assert.NotNull(error);
        Assert.IsType<InvalidDataException>(error.GetBaseException());
    }
}
