# DaatPhoenix.HttpOrchestration

Reusable .NET 10 HTTP support for JSON requests, retrying transient failures,
and polling asynchronous operation endpoints (including Durable Functions).

## Source and maintenance

- Main implementation: `src/HttpOrchestration/HttpOrchestrationClient.cs`.
- Polling defaults and timeout configuration: `src/HttpOrchestration/HttpOrchestrationOptions.cs`.
- Package metadata and version: `src/HttpOrchestration/HttpOrchestration.csproj`.
- Package behavior tests: `tests/HttpOrchestration.Tests/`.
- File Operations configuration adapter: `src/FileOperations/HttpFunctions.cs`. Update this adapter when changing how this application maps setting names, Function keys, or logging identities to generic client calls.

Consumers provide an `HttpClient`, an absolute HTTP(S) endpoint, optional
request headers, and a cancellation token. The library does not read
environment variables, appsettings, or Azure-specific configuration. Create a
NuGet package from the repository root with:

```sh
dotnet pack src/HttpOrchestration/HttpOrchestration.csproj --configuration Release
```

Package publishing is managed separately from this public source repository.

The asynchronous starter response must include a same-origin
`statusQueryGetUri` or `Location` URL. Polling requests do not copy the starter
request's headers; the status URL must carry any required authorization itself.

```csharp
var operations = new HttpOrchestrationClient(httpClient);
var result = await operations.SendAndWaitForCompletionAsync(
    HttpMethod.Post,
    new Uri("https://service.example/api/convert"),
    new { documentId = "123" },
    "document conversion",
    headers: null,
    cancellationToken: cancellationToken);
```
