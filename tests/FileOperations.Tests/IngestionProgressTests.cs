using FileOperations;
using Xunit;

namespace FileOperations.Tests;

public class IngestionProgressTests
{
    private static readonly EventOrder Current = new("639287043700000000", "2", "7");

    [Fact]
    public void DifferentPartitionsAndEnqueueTimesHaveDistinctSafeKeys()
    {
        var key = IngestionProgress.RowKey("123", Current);
        Assert.NotEqual(key, IngestionProgress.RowKey("123", Current with { PartitionId = "9" }));
        Assert.NotEqual(key, IngestionProgress.RowKey("123", Current with { EnqueuedTicks = "1" }));
        Assert.Equal(key, IngestionProgress.RowKey("123", Current));
        Assert.DoesNotContain(key, c => c is '/' or '\\' or '#' or '?' || char.IsControl(c));
    }

    [Fact]
    public void SequenceComesFromEventOrder()
    {
        Assert.EndsWith(":9:123", IngestionProgress.RowKey("123", Current with { SequenceNumber = "9" }));
    }

    [Fact]
    public void MissingEventOrderCannotCreateAnOldFormatKey()
    {
        Assert.Throws<ArgumentNullException>(() => IngestionProgress.RowKey("123", null!));
    }
}
