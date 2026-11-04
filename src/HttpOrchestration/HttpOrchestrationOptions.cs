namespace DaatPhoenix.HttpOrchestration;

public sealed class HttpOrchestrationOptions
{
    public TimeSpan PollingInterval { get; init; } = TimeSpan.FromSeconds(5);
    public TimeSpan MaximumPollingInterval { get; init; } = TimeSpan.FromSeconds(30);
    public TimeSpan Timeout { get; init; } = TimeSpan.FromHours(1);
}
