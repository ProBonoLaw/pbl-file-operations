namespace DaatPhoenix.DataLaw.DataIntegrity.Orchestration;

public interface IIngestionStopStore
{
    Task<bool> IsStoppedAsync(string accountId, string sourceId, string jobId, CancellationToken cancellationToken);
    Task AssertOpenAsync(string accountId, string sourceId, string jobId, CancellationToken cancellationToken);
    Task RunUntilStoppedAsync(string accountId, string sourceId, string jobId,
        Func<CancellationToken, Task> action, CancellationToken cancellationToken);
}
