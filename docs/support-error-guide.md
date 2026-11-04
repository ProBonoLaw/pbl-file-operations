# File Operations error guide for support

Use this guide when an ingestion, document conversion, or evidence extraction job
stops or appears stuck. It covers the error codes this repository deliberately
emits and the exception names support is likely to see. Library and Azure errors
can have other names; use their HTTP status, message, and surrounding events to
choose the matching action below.

## Start with the job identity and outcome

Record the **environment, `accountId`, `sourceId`, and `jobId`** before acting.
`sourceId` is not unique across accounts, and a new ingestion of the same source
has a different `jobId`. For a failed Event Hub record also record its role,
partition, and sequence number. Use the Grafana ingestion dashboard (operational record retained privately)
or Application Insights to find the first failure for that job, rather than
starting with the latest sibling task error. This query is a starting point in
the environment's Log Analytics workspace:

```kusto
AppEvents
| where TimeGenerated > ago(24h)
| where tostring(Properties.accountId) == "ACCOUNT_ID"
  and tostring(Properties.sourceId) == "SOURCE_ID"
| project TimeGenerated, Name, jobId=tostring(Properties.jobId),
          taskId=tostring(Properties.taskId), lane=tostring(Properties.lane),
          state=tostring(Properties.state), errorType=tostring(Properties.errorType),
          attempt=tostring(Properties.attempt)
| order by TimeGenerated asc
```

As a quick rule: task status `pending`, `EvidenceTaskWaiting`, `evidence_budget_busy`, and
`evidence_budget_unavailable` call for monitoring or restoring a dependency;
they do not justify replaying the job. `evidence_unresolved`,
`evidence_budget_exhausted`, and a terminal `content_filter` call for cause
review before a new session. `evidence_job_stopped` points back to an earlier
failure in that same session.

Find the relevant `jobId`, then narrow the query to it. Check whether
`EvidenceIndexingCompleted` has `outcome=SUCCESS` or `SUPERSEDED`, whether
`EvidenceExtractionJobCompleted` exists, and whether a `FAILED` cleanup event
was published. `EvidenceExtractionCompleted` means extraction finished; it does
**not** prove indexing or cleanup finished. `SUPERSEDED` means a newer ingestion,
deletion, or account purge took precedence; do not restart the older job.

The default failed-event Blob container is `file-operations-failed-events` in
checkpoint storage. Ingestion/deletion records live at
`<role>/<partition>/<sequence>.json` and contain `errorType` and the original
`eventBodyBase64`. Evidence event records live at
`evidence-extraction/<partition>/<sequence>.json` and contain an `error` message.
Queued evidence task manifests live in the private
`file-operations-evidence-tasks` container at `tasks/<taskId>.json`; their
`status`, `lane`, `attempts`, and `error` show the task's latest state. A failed
event already checkpointed by a worker will **not** retry automatically. Preserve
these records and source blobs for investigation.

### Request received but no new ingestion progress

Older workers keyed progress by `sequence:offset`, which can repeat in different
Event Hub partitions. A fresh request for the same file could therefore log
`Skipping ingestion event already marked completed` and acknowledge the event
without starting ingestion. Compare its partition and enqueue time with the
saved progress row; a successful `FileOperationProcessed` event alone does not
prove that new work started. The Grafana stage panels only show work that reached
those stages.

New ingestion deliveries use only the new progress key, which includes the
partition, enqueue time, sequence, and offset. The worker does one lookup and
does not consult old `sequence:offset` rows or the old `accountId:identifier`
partition. A repeated delivery under the new process reuses its exact job ID;
`Completed`, `AwaitingEvidence`, and `Stopped` still suppress duplicate work,
even when no `Work` has been saved. Existing cleanup and stop requests retain
their explicit job IDs.

This is a forward cutover. Replaying an old event creates a new-format job;
old progress and stop records are not migrated into it. Deploying this fix does not
replay events already acknowledged: after verifying that no job is active or
superseded, recover an affected request through the approved replay process.
Keep historical progress and checkpoints intact.

## Evidence task codes

These are the `error` values on queued task manifests and the `errorType`
properties of `EvidenceTask*` telemetry. A task can be `pending` while it waits;
the code alone does not mean the entire job failed.

| Code | Meaning | What support should do |
| --- | --- | --- |
| `evidence_budget_busy` | Other in-flight requests have reserved the remaining session allowance. The task waits 15 seconds and tries admission again without using a task attempt. | Check whether other tasks for the same **job** are completing. If it persists beyond the reservation age configured in `EVIDENCE_COST_BUDGET_CONFIG` (normally one hour), escalate for ledger and provider-request review. Do not repeatedly restart workers or raise the cap just to clear reservations. |
| `evidence_budget_unavailable` | The spending ledger could not be read or updated reliably. No new model request is admitted; the task waits and retries. | Check storage availability and the evidence workers' storage credentials. Escalate if storage is healthy but the code persists. |
| `evidence_budget_exhausted` | The session has reached its configured spending stop **or** its `jobId` is on the operator stop list. This is a terminal spending stop for that session. | Read the exception message to distinguish a cap from an operator stop. Review the session ledger and actual provider billing before requesting a new allowance. An authorized new ingestion creates a new `jobId`; replaying the same job does not reset its balance. Never remove an operator stop without approval. |
| `evidence_budget_configuration` | The spending guard cannot establish a safe cost bound. Examples: expired pricing, missing account/source/job identity, unpriced deployment, unsupported request type, changed budget identity, or provider usage beyond a configured bound. | Give engineering the job ID, exact message, deployment, and appsettings version. Correct the configuration or model mapping before a new attempt. Do not bypass the guard merely to make the error disappear. |
| `evidence_unresolved` | A source-support or classification item remains unresolved after repair. The configured Sonnet rescue gets a final opportunity to review it. Remaining unresolved items are omitted individually as `candidateRejected` with reason `citation-unresolved-after-rescue` or `review-unresolved-after-rescue`; verified peers continue. | Check the `candidateRejected` events, page, batch, and source quotations to see exactly what was omitted. If the whole task still fails, inspect the first provider or storage exception; do not assume every stopped sibling had bad evidence. |
| `evidence_structured_invalid` | A gathering unit returned a response that did not match the required schema up to three times. For a multi-page document, that unit completes with no candidates and emits `EvidenceGatheringUnitDropped`; the other units continue. A one-page document instead emits `EvidenceGatheringUnitRejected` and fails visibly to avoid publishing an empty extraction. | Check the `jobId`, `batchId`, stage, and number of dropped units. The omitted source text has not been extracted; review that page and arrange a corrected, budgeted run if the missing evidence matters. Do not treat an empty result from a rejected one-page job as successful. |
| `evidence_output_limit_partitioned` | A gathering model hit its output-token limit, and the affected text was split into smaller, fully covering units. The original task will resume from its saved partition. | Watch the child gathering units for completion. The partition preserves all source text and citation offsets. |
| `evidence_output_limit` | A gathering unit was too small to split further and its model still reached the output-token limit. It moves to the configured Claude rescue model when available. After three rescue failures, only that unit is omitted for a multi-page document and `EvidenceGatheringUnitDropped` records the gap; a one-page document fails visibly. | Check the task's model-attempt events, the rescue deployment, and any dropped unit. Review omitted source text before treating the extraction as complete. |
| `content_filter` | A provider refused the prompt or response. Reconciliation uses the configured rescue model. A queued gathering unit also switches to that model when it is a distinct Claude deployment; if both refuse, only that unit is omitted for a multi-page document and `EvidenceGatheringUnitDropped` records the gap. A one-page document fails visibly. | Check the task's model-attempt events, provider filter reason, and any dropped unit. Review omitted source text before treating the extraction as complete. Do not remove, rewrite, or mask source content just to pass the filter. |
| `evidence_job_stopped` | This task was cancelled because **another task in the same account/source/job failed terminally**, or its finalizer failed. This is usually a secondary symptom. | Find the earliest terminal failure for that `jobId`. Do not restart its stopped child tasks individually. A new ingestion session is separate once the original cause is fixed. |

`EvidenceTaskWaiting` and `EvidenceTaskBudgetWaiting` are wait states, not final
failures. `EvidenceTaskFailover` means a component moved to its repair lane;
`EvidenceTaskJobStopped` means a sibling cancellation was recorded. A terminal
child failure writes a durable job stop marker and prevents further model calls
for that job. Requests already processed by the provider may still incur a
charge. `EvidenceTaskFailed` with no specific code means the task exhausted its
attempts; inspect its manifest and the preceding exception for the real cause.

`eventDateFallbackReviewed` with outcome
`retained-undated-invalid-response` means the configured date-decision retries,
including model failover when available, did not validate for that candidate;
its cited occurrence continues as an undated fact.
Check `candidateRejected` with reason `date-unresolved-invalid-citation` for an
entry omitted because its source quotation could not be verified.
`claimAttributionReviewed` with outcome `retained-original-invalid-response`
means the claim stayed indexed with an unknown claimant after attribution retries.
An unverifiable claim citation is omitted with reason
`attribution-unresolved-invalid-citation`.

## Other evidence exception names

| Name or reason | Meaning | What support should do |
| --- | --- | --- |
| `EvidenceReviewPending`, `EvidenceJobOwnedError` | The finalizer is waiting for child tasks or another worker currently owns the job. | Watch task progress for that `jobId`. Escalate only if no task advances and the relevant worker/queue is unhealthy. |
| `EvidenceGatheringTimeoutError` | One admitted gathering invocation passed its configured deadline. | Check model latency, rate limits, and repeated timeout attempts. Give engineering the page/window and `EVIDENCE_GATHER_TIMEOUT_MS` value; do not blindly increase concurrency. |
| `EvidenceReconciliationTimeoutError` | A reconciliation batch and its repairs/fallbacks exceeded their shared deadline. | Check the batch ID, model latency, and `EVIDENCE_RECONCILIATION_TIMEOUT_MS`. Repeated timeouts need engineering review of batch size, model capacity, or deadline. |
| `EvidenceModelRateLimitError` or provider HTTP `429` | The model endpoint throttled the request. | Check the deployment's quota/capacity and `Retry-After`. The task normally retries; escalate persistent throttling rather than repeatedly resubmitting the document. |
| `EvidenceStructuredResponseError` (`missing`, `refused`, `incomplete`, `invalid`, `content_filter`) | A model response was absent, refused, truncated, malformed, or filtered. | Inspect the `reason` and provider error. A retry or configured rescue may recover it; repeated terminal failures need prompt/schema/model review. |
| `InvalidCitationChoiceError`, `InvalidReconciliationResponseError`, or `ZodError` | A model chose an invalid citation or returned data outside the required contract. | Provide the task ID, source page, and validation message to engineering. Do not manually accept an unsupported citation. |
| `EvidenceJobAttemptError`, `EvidenceTaskRetry`, `EvidenceTaskFailed` | Internal wrappers for a failed attempt, requested retry, or exhausted child task. | Follow the underlying `cause` or the child manifest's `error`. If the job's retry budget is exhausted, fix the cause and submit a **new** ingestion session; the same job ID keeps its spent attempts. |
| `EvidenceJobStopped` | An active queued task observed the durable stop marker and aborted. | Find the earlier terminal failure for the same job. |
| `CheckpointFailure`, task lease or queue delivery errors | The worker could not safely acknowledge progress or retain ownership. | Check Event Hubs checkpoint Blob Storage or the evidence task Queue/Blob account, then worker health. An unacknowledged delivery can replay; verify the final outcome before manual resubmission. |
| `UnknownError` or an unfamiliar exception | No more specific task code was available. | Save the full exception and preceding events, including account/source/job/task IDs, and escalate. Do not infer a data defect from the name alone. |

## Ingestion and document conversion

| Signal | Meaning | What support should do |
| --- | --- | --- |
| Gateway or Data Ingestion API HTTP `400` / `InvalidRequestError` | A required field, mode, ordering value, or request body is invalid. | Check the request against the endpoint contract, especially account ID, source ID, `jobId`, and original event order. Correct the caller before resending. |
| Data Ingestion API HTTP `402` | One of the four `evidence_budget_*` codes above blocked the request. | Read the response's `code` and follow its row above. |
| Azure AI Search HTTP `404`, `The index '...' was not found`, when the configured name is an alias | An incompatible document API version can fail even when the alias exists and index metadata lookup succeeds. SDK 12.2.0 defaults to `2025-09-01`; document clients explicitly use the alias-compatible `2026-04-01` API. | Verify the account's alias mapping and compare a source-filtered query through the alias and its target with the same API version. Deploy the client-version fix before retrying ingestion. Do not replace the alias or recreate the index based only on this 404. |
| `SourcePartitionVisibilityError`, `Source partition count changed while paging`, or `Duplicate source partition while paging` immediately after upload | Search can still be making uploaded partitions visible across paginated reads. Readiness retries complete snapshots for up to 30 seconds, without repeating uploads, and verifies all expected IDs before saving the readiness checkpoint. | Check `sourcePartitionReadinessRetry` and the final ingestion outcome. Older deployments fail immediately on paging errors; deploy the readiness retry fix. Persistent failures still block reconciliation; inspect the reported/read counts, expected partition IDs, and concurrent source writes. |
| Data Integrity lookup HTTP `404` | No cached conversion was found; this can be an ordinary cache miss. | Check whether transformation continued. A transform HTTP `404` instead means a required source file was not found. |
| Data Integrity transform HTTP `422` / `UnprocessableDocumentException` | The document could not be parsed or transformed. An inner `InvalidDataException` can identify corrupt Content Understanding block data. | Verify the **exact file** and format in storage, then inspect the inner exception and conversion logs. Escalate a parser defect with the account/source pair and file type. Do not assume every 422 incurred LLM cost. |
| Content Understanding PDF HTTP `400`, followed by `Previous CU submission failed or has an unknown outcome` | CU rejected the first submission and saved a failed operation, so identical retries cannot submit again. One cause is a PDF over CU's 300-page asynchronous limit. | Check the exact PDF page count and whether it is password-locked. The large-PDF Document Intelligence route handles readable files over the configured CU limit after deployment; submit a **new ingestion session**. Do not clear or rewrite a CU operation journal merely to force another paid submission. |
| `FileNotFoundException` or transform HTTP `404` | The source file or Blob path is missing. | Check SharePoint/Blob location and whether a newer deletion or move superseded this event. Restore or correct the source before a new ingestion. |
| `TransientVideoIndexerException`, HTTP `408`/`429`/`5xx` | An external conversion service timed out, throttled, or failed temporarily. | Check service health and retry behavior. Escalate if repeated after the service recovers. |
| `JsonException`, `InvalidDataException` on an ingestion/deletion event | The Event Hub body is malformed or lacks required data such as `eventKind`. | Inspect the quarantined failed-event record. Correct the publisher, then republish the corrected event through the approved replay process. |
| `MissingSettingException`, `AuthenticationFailedException`, Azure `RequestFailedException`, `CosmosException`, or `HttpRequestException` with `401`/`403`/`408`/`429`/`5xx` | A required configuration, permission, network path, or service is unavailable. The .NET event worker stops without checkpointing this event. | Check the affected service and role permissions, restore access, and restart/let Kubernetes restart the worker. The event should redeliver from its checkpoint; avoid manual republishing unless it was separately quarantined. |
| `SharePointGraphAuthorizationException` | Shared-resource sync cannot read a required SharePoint resource. | Check the Graph/SharePoint permission and affected account/site. The sync will retry on a later run after access is restored. |
| Data Ingestion API HTTP `500` or another exception name | The server could not complete indexing or removal. | Use request logs and `DataIngestionApiRequestCompleted`/`EvidenceIndexingCompleted` to determine whether the operation actually committed before retrying. Escalate with account/source/job and the response body. |

`OperationCanceledException` during a planned worker shutdown is usually a
drain/restart signal, not proof that a document failed. `FileIngestionCleanup`
with status `FAILED` is an outcome, not an error type: the job retained its source
blobs for review. A failed event with an arbitrary .NET `errorType` is classified
by its message, HTTP status, and the rows above; the field contains the runtime
exception class, so it is not a fixed list.

## Before any replay or configuration change

Confirm the job's final indexing outcome and whether a newer source operation
superseded it. Preserve the failed-event record, task manifest, checkpoints, and
source files. Give engineering the environment, account ID, source ID, job ID,
first failing task ID, error message, attempt count, and relevant deployment or
HTTP status. A new ingestion session may repeat paid model work; get the normal
spending approval before using `evidenceBudgetOverride: true` or raising a cap.
