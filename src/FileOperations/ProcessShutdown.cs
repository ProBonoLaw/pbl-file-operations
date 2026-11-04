using System.Globalization;

namespace FileOperations;

/// <summary>Bounds draining and host disposal, including SDK calls that ignore cancellation.</summary>
internal sealed class ProcessShutdown : IDisposable
{
    private readonly object gate = new();
    private readonly IDisposable stopping;
    private Timer? deadline;
    private bool disposed;

    internal static string ServiceName(string role) => role switch
    {
        "gateway" => "file-ops-gateway",
        "ingestion" => "general-ingestion",
        "deletion" => "general-deletion",
        _ => role
    };

    internal static TimeSpan Timeout(string role, Func<string, string?>? setting = null)
    {
        setting ??= Settings.Get;
        var name = ServiceName(role).ToUpperInvariant().Replace('-', '_') + "_SHUTDOWN_TIMEOUT_MS";
        var configured = setting(name) ?? setting("PROCESS_SHUTDOWN_TIMEOUT_MS") ?? "300000";
        if (!int.TryParse(configured, NumberStyles.None, CultureInfo.InvariantCulture, out var milliseconds)
            || milliseconds < 1000 || milliseconds > 3_600_000)
            throw new InvalidOperationException($"{name} / PROCESS_SHUTDOWN_TIMEOUT_MS must be an integer from 1000 to 3600000");
        return TimeSpan.FromMilliseconds(milliseconds);
    }

    internal static void Configure(IServiceCollection services, string role) =>
        services.Configure<HostOptions>(options => options.ShutdownTimeout = Timeout(role));

    internal static ProcessShutdown Watch(IHost host, string role) => new(
        host.Services.GetRequiredService<IHostApplicationLifetime>(), Timeout(role), ServiceName(role),
        host.Services.GetRequiredService<ILogger<ProcessShutdown>>(), Environment.Exit);

    internal ProcessShutdown(IHostApplicationLifetime lifetime, TimeSpan timeout, string service,
        ILogger logger, Action<int> exit)
    {
        stopping = lifetime.ApplicationStopping.Register(() =>
        {
            lock (gate)
            {
                if (disposed || deadline is not null) return;
                logger.LogInformation("{Service} stopping; shutdown deadline {TimeoutMs} ms", service, timeout.TotalMilliseconds);
                deadline = new Timer(_ =>
                {
                    lock (gate)
                    {
                        if (disposed) return;
                        try { logger.LogError("{Service} shutdown deadline exceeded; forcing process exit", service); }
                        finally { exit(1); }
                    }
                }, null, timeout, System.Threading.Timeout.InfiniteTimeSpan);
            }
        });
    }

    public void Dispose()
    {
        lock (gate)
        {
            disposed = true;
            deadline?.Dispose();
        }
        stopping.Dispose();
    }
}
