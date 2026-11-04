using Azure;
using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Processor;
using FileOperations;
using Microsoft.ApplicationInsights;
using Microsoft.ApplicationInsights.Extensibility;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FileOperations.Tests;

public class EventWorkerTests
{
    [Fact]
    public async Task StoresFailedEventBeforeCheckpointAndContinuesProcessing()
    {
        var settings = new Dictionary<string, string>
        {
            ["ROLE"] = "deletion",
            ["STORAGE_ACCOUNT_NAME"] = "evidencetest",
            ["CHECKPOINT_CONTAINER"] = "file-operations-checkpoints",
            ["EVENTHUB_CONSUMER_GROUP"] = "test",
            ["EVENTHUB_NAMESPACE"] = "example.servicebus.windows.net"
        };
        var previous = settings.Keys.ToDictionary(name => name, Environment.GetEnvironmentVariable);
        try
        {
            foreach (var setting in settings)
                Environment.SetEnvironmentVariable(setting.Key, setting.Value);

            using var telemetryConfiguration = TelemetryConfiguration.CreateDefault();
            telemetryConfiguration.DisableTelemetry = true;
            var failedEvents = new RecordingFailedEventStore();
            var lifetime = new StubLifetime();
            await using var worker = new EventWorker(lifetime, new StubHttpClientFactory(),
                NullLogger<EventWorker>.Instance, NullLoggerFactory.Instance,
                new TelemetryClient(telemetryConfiguration), failedEvents);
            var checkpointed = 0;

            var missingId = """{"contentData":{"eventKind":"FileDeletion","accountId":"account"}}""";
            await worker.ProcessAsync(Event(missingId, 1, _ =>
            {
                Assert.Single(failedEvents.Saved);
                checkpointed++;
                return Task.CompletedTask;
            }));
            await worker.ProcessAsync(Event("""{"contentData":{"eventKind":"FileIngestion"}}""",
                2, _ =>
                {
                    checkpointed++;
                    return Task.CompletedTask;
                }));

            Assert.Equal(2, checkpointed);
            Assert.Equal(0, lifetime.StopCalls);
            var failure = Assert.Single(failedEvents.Saved);
            Assert.Equal("deletion", failure.Role);
            Assert.Equal("0", failure.PartitionId);
            Assert.Equal(1, failure.SequenceNumber);
            Assert.Equal("FileDeletion", failure.EventKind);
            Assert.Equal(missingId, failure.EventBody.ToString());
        }
        finally
        {
            foreach (var setting in previous)
                Environment.SetEnvironmentVariable(setting.Key, setting.Value);
        }
    }

    [Fact]
    public async Task CheckpointFailureStopsWorkerWithoutAdvancing()
    {
        using var settings = new WorkerSettingsScope();
        using var telemetryConfiguration = TelemetryConfiguration.CreateDefault();
        telemetryConfiguration.DisableTelemetry = true;
        var lifetime = new StubLifetime();
        var failedEvents = new RecordingFailedEventStore();
        await using var worker = new EventWorker(lifetime, new StubHttpClientFactory(),
            NullLogger<EventWorker>.Instance, NullLoggerFactory.Instance,
            new TelemetryClient(telemetryConfiguration), failedEvents);
        var previousExitCode = Environment.ExitCode;
        try
        {
            var checkpointAttempts = 0;
            await worker.ProcessAsync(Event("""{"eventKind":"FileIngestion"}""", 1, _ =>
            {
                checkpointAttempts++;
                throw new IOException("checkpoint unavailable");
            }));
            await worker.ProcessAsync(Event("""{"eventKind":"FileIngestion"}""", 2, _ =>
            {
                checkpointAttempts++;
                return Task.CompletedTask;
            }));

            Assert.Equal(1, checkpointAttempts);
            Assert.Equal(1, lifetime.StopCalls);
            Assert.Equal(1, Environment.ExitCode);
            Assert.Empty(failedEvents.Saved);
        }
        finally
        {
            Environment.ExitCode = previousExitCode;
        }
    }

    [Fact]
    public async Task FailureStoreErrorStopsWithoutCheckpointing()
    {
        using var settings = new WorkerSettingsScope();
        using var telemetryConfiguration = TelemetryConfiguration.CreateDefault();
        telemetryConfiguration.DisableTelemetry = true;
        var lifetime = new StubLifetime();
        await using var worker = new EventWorker(lifetime, new StubHttpClientFactory(),
            NullLogger<EventWorker>.Instance, NullLoggerFactory.Instance,
            new TelemetryClient(telemetryConfiguration), new FailingFailedEventStore());
        var previousExitCode = Environment.ExitCode;
        try
        {
            var checkpointed = false;
            await worker.ProcessAsync(Event("not-json", 1, _ =>
            {
                checkpointed = true;
                return Task.CompletedTask;
            }));

            Assert.False(checkpointed);
            Assert.Equal(1, lifetime.StopCalls);
            Assert.Equal(1, Environment.ExitCode);
        }
        finally
        {
            Environment.ExitCode = previousExitCode;
        }
    }

    [Fact]
    public async Task ProcessorCheckpointStoreErrorStopsWorker()
    {
        using var settings = new WorkerSettingsScope();
        using var telemetryConfiguration = TelemetryConfiguration.CreateDefault();
        telemetryConfiguration.DisableTelemetry = true;
        var lifetime = new StubLifetime();
        await using var worker = new EventWorker(lifetime, new StubHttpClientFactory(),
            NullLogger<EventWorker>.Instance, NullLoggerFactory.Instance,
            new TelemetryClient(telemetryConfiguration), new RecordingFailedEventStore());
        var previousExitCode = Environment.ExitCode;
        try
        {
            await worker.ErrorAsync(new ProcessErrorEventArgs(null, "LoadBalancing",
                new RequestFailedException(404, "checkpoint container missing"), CancellationToken.None));

            Assert.Equal(1, lifetime.StopCalls);
            Assert.Equal(1, Environment.ExitCode);
        }
        finally
        {
            Environment.ExitCode = previousExitCode;
        }
    }

    [Theory]
    [InlineData(403, true)]
    [InlineData(404, false)]
    [InlineData(500, true)]
    public void ClassifiesStorageErrors(int status, bool fatal) =>
        Assert.Equal(fatal, EventWorker.IsInfrastructureFailure(
            new RequestFailedException(status, "storage failure")));

    [Fact]
    public void MissingSettingIsInfrastructureFailure() =>
        Assert.True(EventWorker.IsInfrastructureFailure(new MissingSettingException("TEST_SETTING")));

    [Theory]
    [InlineData("""{"contentData":{"eventKind":"FileIngestion","accountId":"enveloped-account","sourceId":"explicit-source","identifier":"Shared Documents/file"}}""",
        "enveloped-account", "explicit-source")]
    [InlineData("""{"eventKind":"FileIngestion","accountId":"root-account","sourceId":42}""",
        "root-account", "42")]
    [InlineData("""{"contentData":{"eventKind":"Website_Data_Ingestion","accountId":"website-account","identifier":"website-source"}}""",
        "website-account", "website-source")]
    [InlineData("""{"eventKind":"FileDeletion","accountId":"deletion-account","id":123,"isFolder":true}""",
        "deletion-account", "123")]
    [InlineData("""{"eventKind":"FileIngestion","accountId":"file-account","identifier":"Shared Documents/file"}""",
        "file-account", null)]
    public async Task EventLogsCarryExpectedIdentityScope(string body, string accountId,
        string? sourceId)
    {
        using var settings = new WorkerSettingsScope();
        using var telemetryConfiguration = TelemetryConfiguration.CreateDefault();
        telemetryConfiguration.DisableTelemetry = true;
        var logger = new ScopeRecordingLogger();
        await using var worker = new EventWorker(new StubLifetime(), new StubHttpClientFactory(),
            logger, NullLoggerFactory.Instance, new TelemetryClient(telemetryConfiguration),
            new RecordingFailedEventStore());

        await worker.ProcessAsync(Event(body, 1, _ => Task.CompletedTask));

        var processed = Assert.Single(logger.Logs, log => log.Message.StartsWith("Processed ",
            StringComparison.Ordinal));
        Assert.Equal(accountId, processed.Scope["accountId"]);
        if (sourceId is null)
            Assert.False(processed.Scope.ContainsKey("sourceId"));
        else
            Assert.Equal(sourceId, processed.Scope["sourceId"]);
        Assert.Empty(logger.ActiveScopes);
    }

    [Fact]
    public async Task MalformedEventLogsWithoutIdentityScope()
    {
        using var settings = new WorkerSettingsScope();
        using var telemetryConfiguration = TelemetryConfiguration.CreateDefault();
        telemetryConfiguration.DisableTelemetry = true;
        var logger = new ScopeRecordingLogger();
        var failedEvents = new RecordingFailedEventStore();
        await using var worker = new EventWorker(new StubLifetime(), new StubHttpClientFactory(),
            logger, NullLoggerFactory.Instance, new TelemetryClient(telemetryConfiguration), failedEvents);
        var checkpointed = false;

        await worker.ProcessAsync(Event("not-json", 1, _ =>
        {
            checkpointed = true;
            return Task.CompletedTask;
        }));

        Assert.True(checkpointed);
        Assert.Single(failedEvents.Saved);
        Assert.Contains(logger.Logs, log => log.Message.StartsWith("Failed processing ",
            StringComparison.Ordinal));
        Assert.All(logger.Logs, log => Assert.Empty(log.Scope));
        Assert.Empty(logger.ActiveScopes);
    }

    private static ProcessEventArgs Event(string body, long sequence,
        Func<CancellationToken, Task> checkpoint)
    {
        var partition = EventHubsModelFactory.PartitionContext("0", default);
        var data = EventHubsModelFactory.EventData(BinaryData.FromString(body),
            new Dictionary<string, object>(), new Dictionary<string, object>(),
            null, sequence, sequence.ToString(), DateTimeOffset.UtcNow);
        return new ProcessEventArgs(partition, data, checkpoint, CancellationToken.None);
    }

    private sealed class RecordingFailedEventStore : IFailedEventStore
    {
        public List<FailedEvent> Saved { get; } = [];

        public Task<string> SaveAsync(FailedEvent failedEvent, CancellationToken cancellationToken)
        {
            Saved.Add(failedEvent);
            return Task.FromResult("deletion/0/1.json");
        }
    }

    private sealed class FailingFailedEventStore : IFailedEventStore
    {
        public Task<string> SaveAsync(FailedEvent failedEvent, CancellationToken cancellationToken) =>
            throw new IOException("failure store unavailable");
    }

    private sealed class StubLifetime : IHostApplicationLifetime
    {
        public int StopCalls { get; private set; }
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => CancellationToken.None;
        public CancellationToken ApplicationStopped => CancellationToken.None;
        public void StopApplication() => StopCalls++;
    }

    private sealed class WorkerSettingsScope : IDisposable
    {
        private readonly Dictionary<string, string?> previous;

        public WorkerSettingsScope()
        {
            var settings = new Dictionary<string, string>
            {
                ["ROLE"] = "deletion",
                ["STORAGE_ACCOUNT_NAME"] = "evidencetest",
                ["CHECKPOINT_CONTAINER"] = "file-operations-checkpoints",
                ["EVENTHUB_CONSUMER_GROUP"] = "test",
                ["EVENTHUB_NAMESPACE"] = "example.servicebus.windows.net"
            };
            previous = settings.Keys.ToDictionary(name => name, Environment.GetEnvironmentVariable);
            foreach (var setting in settings)
                Environment.SetEnvironmentVariable(setting.Key, setting.Value);
        }

        public void Dispose()
        {
            foreach (var setting in previous)
                Environment.SetEnvironmentVariable(setting.Key, setting.Value);
        }
    }

    private sealed class StubHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }

    private sealed class ScopeRecordingLogger : ILogger<EventWorker>
    {
        public List<IReadOnlyDictionary<string, object?>> ActiveScopes { get; } = [];
        public List<(string Message, IReadOnlyDictionary<string, object?> Scope)> Logs { get; } = [];

        public IDisposable BeginScope<TState>(TState state) where TState : notnull
        {
            var dimensions = state is IEnumerable<KeyValuePair<string, object?>> entries
                ? entries.ToDictionary(entry => entry.Key, entry => entry.Value)
                : new Dictionary<string, object?>();
            ActiveScopes.Add(dimensions);
            return new ScopeHandle(() => ActiveScopes.Remove(dimensions));
        }

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state,
            Exception? exception, Func<TState, Exception?, string> formatter)
        {
            var dimensions = ActiveScopes.SelectMany(scope => scope)
                .ToDictionary(entry => entry.Key, entry => entry.Value);
            Logs.Add((formatter(state, exception), dimensions));
        }

        private sealed class ScopeHandle(Action onDispose) : IDisposable
        {
            public void Dispose() => onDispose();
        }
    }
}
