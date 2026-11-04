# File Operations

File Operations ingests, transforms, indexes, and removes documents and websites.
It includes a .NET 10 gateway and workers, a document transformation API, and a
Bun service for search indexing and evidence extraction.

| Component | Source | Responsibility |
| --- | --- | --- |
| Gateway and workers | `src/FileOperations` | HTTP ingestion/deletion, Event Hubs processing, SharePoint sync, progress, and notifications |
| Data Integrity | `src/DataIntegrityService` | Document, audio, and video transformation and cached Markdown |
| Data Ingestion | `src/DataIngestionService` | Search indexing, removal, and evidence extraction |
| HTTP orchestration | `src/HttpOrchestration` | Reusable HTTP retries and asynchronous operation polling |

## Build and test

Install .NET 10 and the Bun version specified in `.bun-version`. All package
sources are public; no GitHub Packages or Azure credentials are needed to build
or run the offline tests. On Ubuntu, install the native document dependencies
with the provided installer (it uses sudo when needed):

```sh
bash .github/scripts/install-test-dependencies.sh
bun install --cwd src/DataIngestionService --frozen-lockfile
bun run --cwd src/DataIngestionService lint
bun run --cwd src/DataIngestionService test
dotnet test tests/HttpOrchestration.Tests/HttpOrchestration.Tests.csproj --configuration Release
dotnet test tests/FileOperations.Tests/FileOperations.Tests.csproj --configuration Release
```

Build the containers locally:

```sh
docker build -t file-operations:local .
docker build -t file-operations-data-ingestion:local src/DataIngestionService
```

Notifications use the HTTP JSON adapter in `src/FileOperations/NotificationClient.cs`.
It sends ingestion and feedback notices to `/api/sendNotice`, requires HTTP 202,
and propagates errors and cancellation without retrying a possibly persisted notice.

## Local configuration

Copy `.vscode/azure-test.appsettings.json.example` to
`.vscode/azure-test.appsettings.json` and supply resources from your own environment.
The Production example documents the same application settings with an alternative
provider configuration; neither example identifies an existing deployment.
The application reads the file selected by `APPSETTINGS_FILE`, and environment
variables override file values. Local settings, environment files, certificates,
and generated outputs are ignored by Git.

Azure-backed execution needs your own Event Hubs, Blob/Queue/Table Storage,
Cosmos DB, Search, AI endpoints, and SharePoint application permissions. Storage
and Cosmos access use `DefaultAzureCredential`; hosted workloads can use
managed identity. Keep runtime credentials in a secret store and mount or inject
them at runtime. Public CI uses offline tests and does not connect to these services.

The VS Code launch profiles run the gateway on `http://localhost:5080`, Data
Integrity on `http://localhost:5081`, and Data Ingestion on `http://localhost:5082`.
Create an ignored `.devcontainer/.env` file before using the development container.

## Gateway API

All gateway endpoints require `X-API-Key`, configured through `GATEWAY_API_KEY`.

| Method and route | Request fields |
| --- | --- |
| `POST /v1/file-operations/ingestion` | `accountId`, `identifier`, `isFolder`; optional `highRes`, `force`, `evidenceExtractionMode` |
| `POST /v1/file-operations/website-ingestion` | `accountId`, `identifier`, `url`; optional `highRes`, `force` |
| `POST /v1/file-operations/deletion` | `accountId`, `id`, `isFolder` |
| `POST /v1/file-operations/ingestion/stop` | `accountId`, `sourceId`, full `jobId` |

Ingestion and deletion return HTTP 202 after the event is accepted. The stop
endpoint records a durable stop request for one submission; calls already in
flight may finish. A new submission has a different job ID.

The default SharePoint identifier mode decodes connector paths and resolves them
through Microsoft Graph to list-item IDs. Configure `SHAREPOINT_HOST`,
`SHAREPOINT_SITE_PREFIX`, and the application's Graph identity for your own tenant.
The default site pattern is `https://<SHAREPOINT_HOST>/sites/<accountId>`.

## Deployment and maintenance

Production deployment is operated separately in a private repository. This
repository contains application checks and container build checks. See
[deployment boundaries](docs/deployment.md) and [publication checks](docs/publication.md).

- [Evidence extraction](docs/evidence-extraction.md)
- [Asynchronous evidence review](docs/evidence-async-review.md)
- [Evidence spending limits](docs/evidence-cost-budget.md)
- [Content Understanding integration](docs/content-understanding-migration.md)
- [Evidence search and RAG integration](docs/evidence-rag-integration.md)
- [Support error guide](docs/support-error-guide.md)
- [Reusable HTTP client](src/HttpOrchestration/README.md)

## License

Copyright 2026 ProBono Law. Licensed under the [Apache License, Version 2.0](LICENSE). See
[CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the
[code of conduct](CODE_OF_CONDUCT.md).
