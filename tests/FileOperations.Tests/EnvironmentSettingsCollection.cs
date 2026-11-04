using Xunit;

namespace FileOperations.Tests;

// Process-wide environment changes must not overlap any other test collection.
[CollectionDefinition(nameof(EnvironmentSettingsCollection), DisableParallelization = true)]
public sealed class EnvironmentSettingsCollection { }
