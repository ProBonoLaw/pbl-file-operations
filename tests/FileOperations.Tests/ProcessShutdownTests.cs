using FileOperations;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FileOperations.Tests;

public class ProcessShutdownTests
{
    [Theory]
    [InlineData("gateway", "FILE_OPS_GATEWAY")]
    [InlineData("ingestion", "GENERAL_INGESTION")]
    [InlineData("deletion", "GENERAL_DELETION")]
    [InlineData("data-integrity-api", "DATA_INTEGRITY_API")]
    [InlineData("shared-resource-sync", "SHARED_RESOURCE_SYNC")]
    public void UsesServiceOverrideBeforeSharedAppsetting(string role, string key)
    {
        var settings = new Dictionary<string, string>
        {
            ["PROCESS_SHUTDOWN_TIMEOUT_MS"] = "300000",
            [key + "_SHUTDOWN_TIMEOUT_MS"] = "120000"
        };
        Assert.Equal(TimeSpan.FromMinutes(2), ProcessShutdown.Timeout(role, name => settings.GetValueOrDefault(name)));
        settings.Remove(key + "_SHUTDOWN_TIMEOUT_MS");
        Assert.Equal(TimeSpan.FromMinutes(5), ProcessShutdown.Timeout(role, name => settings.GetValueOrDefault(name)));
    }

    [Theory]
    [InlineData("0")]
    [InlineData("999")]
    [InlineData("3600001")]
    [InlineData("1.5")]
    [InlineData("bad")]
    [InlineData("")]
    public void RejectsInvalidTimeout(string configured) =>
        Assert.Throws<InvalidOperationException>(() => ProcessShutdown.Timeout("gateway", _ => configured));

    [Fact]
    public async Task ForcesExitOnlyAfterApplicationStartsStopping()
    {
        var lifetime = new Lifetime();
        var exited = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var shutdown = new ProcessShutdown(lifetime, TimeSpan.FromMilliseconds(50), "test-service",
            NullLogger.Instance, code => exited.TrySetResult(code));
        await Task.Delay(100);
        Assert.False(exited.Task.IsCompleted);
        lifetime.StopApplication();
        Assert.Equal(1, await exited.Task.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task CancelsDeadlineAfterHostHasDrainedAndDisposed()
    {
        var lifetime = new Lifetime();
        var exited = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var shutdown = new ProcessShutdown(lifetime, TimeSpan.FromMilliseconds(100), "test-service",
            NullLogger.Instance, code => exited.TrySetResult(code));
        lifetime.StopApplication();
        shutdown.Dispose();
        await Task.Delay(200);
        Assert.False(exited.Task.IsCompleted);
    }

    private sealed class Lifetime : IHostApplicationLifetime
    {
        private readonly CancellationTokenSource stopping = new();
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => stopping.Token;
        public CancellationToken ApplicationStopped => CancellationToken.None;
        public void StopApplication() => stopping.Cancel();
    }
}
