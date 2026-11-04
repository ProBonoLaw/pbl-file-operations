# Contributing

Thank you for helping. Contributions are accepted under the Apache License 2.0
(see [LICENSE](LICENSE)); by submitting a pull request you agree that your
contribution is licensed under those terms.

## Before you start

- Open an issue to discuss significant changes first.
- Never include credentials, Azure resource names, tenant or subscription IDs,
  or content from real legal matters in code, tests, docs, issues, or logs.
  Test fixtures must use synthetic people, dates, and documents.
- Security problems go through private reporting; see [SECURITY.md](SECURITY.md).

## Build and test

Follow the instructions in [README.md](README.md). Pull requests must pass:

```sh
bun run --cwd src/DataIngestionService lint
bun run --cwd src/DataIngestionService test
dotnet test tests/HttpOrchestration.Tests/HttpOrchestration.Tests.csproj --configuration Release
dotnet test tests/FileOperations.Tests/FileOperations.Tests.csproj --configuration Release
node --test .github/scripts/check-public-repository.test.mjs
node .github/scripts/check-public-repository.mjs
```

The repository hygiene workflow also runs identifier and credential scans; see
[docs/publication.md](docs/publication.md).

## Pull requests

Keep changes focused, add or update tests, and describe the behavior change.
This repository is the upstream for shared code; changes are made here first and
then merged into downstream deployments. See
[docs/publication.md](docs/publication.md#ongoing-workflow).
