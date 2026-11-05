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

The package is published from this repository to ProBonoLaw's GitHub Packages
NuGet feed: `https://nuget.pkg.github.com/probonolaw/index.json`. Its package ID
and namespace remain `DaatPhoenix.HttpOrchestration` for consumer compatibility.
Version `1.0.2` starts publication from this public source and avoids reusing
cached versions from the earlier feed.

After merging a version update into `main`, run **Publish HttpOrchestration**
from the repository's Actions tab. The workflow tests and packs the library,
checks package metadata and contents, then publishes with its short-lived
`GITHUB_TOKEN`. Publishing is restricted to this repository's `main`; pull
requests only build and validate the package. Retain the existing attribution,
Apache-2.0 license, and NOTICE in redistributed packages.

GitHub initially publishes packages as private. After the first publication,
an organization package administrator must make the package public in its
package settings and grant consuming repositories Actions read access.
GitHub requires authentication even when installing a public NuGet package.
Actions consumers can use `GITHUB_TOKEN` with `packages: read` when access is
granted; local users can use a personal access token (classic) with
`read:packages`. Do not commit a token to NuGet configuration. See
[GitHub's NuGet registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-nuget-registry).

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
