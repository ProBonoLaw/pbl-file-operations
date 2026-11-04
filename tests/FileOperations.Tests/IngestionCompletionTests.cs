using FileOperations;
using Xunit;

namespace FileOperations.Tests;

public class IngestionCompletionTests
{
    [Fact]
    public async Task SharedResourceCompletionDoesNotClaimEvidenceWasExtracted()
    {
        var actions = new List<string>();
        await IngestionCompletion.CleanupAsync("SUCCESS", status =>
        {
            actions.Add(status.ToString()); return Task.CompletedTask;
        }, () => { actions.Add("cleanup"); return Task.CompletedTask; }, evidenceExtractionSkipped: true);
        Assert.Equal(["cleanup", "SUCCESS"], actions);
    }
    [Fact]
    public async Task SendsStagesInOrderAndSuccessOnlyAfterCleanup()
    {
        var actions = new List<string>();
        Task Record(string action) { actions.Add(action); return Task.CompletedTask; }
        await IngestionCompletion.SubmitAsync(() => Record("index chunks"),
            () => Record("PRELIMINARY"), () => Record("publish evidence"));
        await IngestionCompletion.CleanupAsync("SUCCESS", status => Record(status.ToString()),
            () => Record("cleanup blobs"));
        Assert.Equal(["index chunks", "PRELIMINARY", "publish evidence", "EVIDENCE_EXTRACTION", "cleanup blobs", "SUCCESS"], actions);
    }

    [Fact]
    public async Task IndexingFailureEmitsNoCompletionNoticeOrEvidenceHandoff()
    {
        var actions = new List<string>();
        await Assert.ThrowsAsync<IOException>(() => IngestionCompletion.SubmitAsync(
            () => throw new IOException("index unavailable"),
            () => { actions.Add("PRELIMINARY"); return Task.CompletedTask; },
            () => { actions.Add("publish evidence"); return Task.CompletedTask; }));
        Assert.Empty(actions);
    }

    [Fact]
    public async Task PreliminaryFailurePreventsEvidenceHandoff()
    {
        var published = false;
        await Assert.ThrowsAsync<IOException>(() => IngestionCompletion.SubmitAsync(
            () => Task.CompletedTask, () => throw new IOException("notification unavailable"),
            () => { published = true; return Task.CompletedTask; }));
        Assert.False(published);
    }

    [Fact]
    public async Task EvidenceNoticeFailurePreventsCleanupAndFinalSuccess()
    {
        var actions = new List<string>();
        await Assert.ThrowsAsync<IOException>(() => IngestionCompletion.CleanupAsync("SUCCESS", status =>
        {
            actions.Add(status.ToString());
            throw new IOException("notification unavailable");
        }, () => { actions.Add("cleanup"); return Task.CompletedTask; }));
        Assert.Equal(["EVIDENCE_EXTRACTION"], actions);
    }

    [Fact]
    public async Task CleanupFailureDoesNotEmitSuccess()
    {
        var statuses = new List<IngestionStatus>();
        await Assert.ThrowsAsync<IOException>(() => IngestionCompletion.CleanupAsync("SUCCESS", status =>
        {
            statuses.Add(status);
            return Task.CompletedTask;
        }, () => throw new IOException("cleanup unavailable")));
        Assert.Equal([IngestionStatus.EVIDENCE_EXTRACTION], statuses);
    }

    [Theory]
    [InlineData("FAILED", false, "FAILED")]
    [InlineData("SUPERSEDED", true, null)]
    public async Task FailedAndSupersededJobsEmitNoCompletionNotices(string status,
        bool expectedCleanup, string? expectedNotice)
    {
        var cleaned = false;
        var statuses = new List<string>();
        await IngestionCompletion.CleanupAsync(status, value =>
        {
            statuses.Add(value.ToString()); return Task.CompletedTask;
        }, () => { cleaned = true; return Task.CompletedTask; });
        Assert.Equal(expectedCleanup, cleaned);
        Assert.Equal(expectedNotice is null ? [] : new[] { expectedNotice }, statuses);
    }

    [Fact]
    public async Task InvalidCleanupStatusEmitsNothing()
    {
        var touched = false;
        await Assert.ThrowsAsync<InvalidDataException>(() => IngestionCompletion.CleanupAsync("PRELIMINARY",
            _ => { touched = true; return Task.CompletedTask; },
            () => { touched = true; return Task.CompletedTask; }));
        Assert.False(touched);
    }
}
