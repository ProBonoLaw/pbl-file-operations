# Storage configuration

Use separate storage accounts for each environment. Configure
`STORAGE_ACCOUNT_NAME` and `INPUT_ACCOUNT_NAME` with your own account names.
Application storage access uses `DefaultAzureCredential` and requires Blob, Queue,
and Table data permissions. Keys and connection strings are not required.

When migrating storage, preserve input documents, results, checkpoints, queues,
progress tables, and ordering records together. Pause consumers during migration
and verify access before resuming them. Environment inventories and the operational
migration procedure are maintained in the private deployment repository.

See [deployment boundaries](deployment.md).
