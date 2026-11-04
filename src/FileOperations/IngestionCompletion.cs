
namespace FileOperations;

/// <summary>Orders completion notices around indexing, evidence handoff and cleanup.</summary>
internal static class IngestionCompletion
{
    internal static async Task SubmitAsync(Func<Task> indexChunks, Func<Task> notifyPreliminary,
        Func<Task> publishEvidence)
    {
        await indexChunks();
        await notifyPreliminary();
        await publishEvidence();
    }

    internal static async Task CleanupAsync(string status, Func<IngestionStatus, Task> notify,
        Func<Task> cleanup, bool evidenceExtractionSkipped = false)
    {
        if (status is not ("SUCCESS" or "SUPERSEDED" or "FAILED"))
            throw new InvalidDataException("Invalid cleanup status");
        if (status == "FAILED")
        {
            await notify(IngestionStatus.FAILED);
            return;
        }
        if (status == "SUCCESS" && !evidenceExtractionSkipped) await notify(IngestionStatus.EVIDENCE_EXTRACTION);
        await cleanup();
        if (status == "SUCCESS") await notify(IngestionStatus.SUCCESS);
    }
}
