# Recovering saved evidence through finalization and Search upload

`src/DataIngestionService/scripts/run-evidence-finalization-replay.mjs` runs
finalization against an immutable, validated extraction snapshot. It calls the
deployed deduplication reviewer and the normal ingestion API for Search upload.
It never invokes extraction or reopens the original stopped job.
CurrentOrder sources use local source lookup, matching normal ingestion; their
tagged partitions are excluded from the untagged hybrid lookup corpus.

## Recovery artifacts

Store the following under one prefix in the private
`file-operations-evidence-replays` Blob container:

- `input.json`: version 1, account/source IDs, original job ID, source content
  hash, the source `Document`, and every validated pre-finalization `Document`.
- `extraction-package.json`: the original extraction package used to restore
  source locations.
- `manifest.json`: the input and extraction-package SHA-256 hashes, document
  count, account/source IDs, original and replay job IDs, source content hash,
  original ordered request with the replay job ID and `evidenceBudgetOverride:
  false`, and approved stage limits and budget fingerprints.
- `original-windows/`: the original completed window results and their checksum
  manifest, retained for recovery independently of ingestion cleanup.

Validate every original window and source citation before preparing `input.json`.
The runner checks the frozen input checksum and document/source identities; it
does not reconstruct or revalidate the extraction model's original output.

The manifest's `limitUsd` must equal `reviewLimitUsd + indexLimitUsd`.
All three amounts must be positive finite JSON numbers with at most six decimal
places. The runner converts each amount to integer USD micros before checking
the total or matching the selected budget; it never compares dollar floats.
`budgetFingerprint` identifies the review budget; keep the separately selected
indexing budget fingerprint and scope in the manifest for operational checks.
The runner validates its own review selection. Verify the API's indexing
selection separately before starting work.

## Running in AKS

Use an isolated Job with the deployed ingestion image, the service's workload
identity, existing application settings, and these overrides:

- `EVIDENCE_REPLAY_PREFIX`: the prepared Blob prefix, ending in `/`.
- `EVIDENCE_REPLAY_MANIFEST_SHA256`: the checksum of the exact manifest bytes.
- `EVIDENCE_COST_BUDGET_CONFIG`: a source-scoped durable review limit with
  verified prices for the actual deployment.
- `EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME`: an explicitly priced deployment.
- `EVIDENCE_RECONCILIATION_PROVIDER`: the matching provider.
- `EVIDENCE_REPLAY_VALIDATE_ONLY=true` for the initial no-model preflight.
- `APPLICATIONINSIGHTS_CONNECTION_STRING`: copy the deployed environment's
  telemetry override explicitly. The shared settings file can contain a
  historical destination that the environment's Grafana cannot read.

Mount both replay scripts at `/app/scripts/<filename>` using individual
ConfigMap `subPath` mounts. Mounting the whole directory introduces Kubernetes
symlink paths that break the scripts' relative imports of `/app/dist`.
Run `bun scripts/run-evidence-finalization-replay.mjs` from `/app`.

Configure and verify a separate source-scoped indexing limit on the ingestion
API. The two limits must fit the same approved total. Keep unrelated source
limits and their price fingerprints unchanged. Start the actual Job with
`EVIDENCE_REPLAY_VALIDATE_ONLY=false` only after preflight and API budget checks
pass. A budget failure stops work; it does not grant another spending window.

## Resuming and verifying completion

The replay renews an ownership lease and checks source ordering, account purge,
and its stopped-job marker while running. A newer source operation blocks the
replay. It pins the deployed implementation, relevant configuration, input,
and review budget so a restart cannot silently change the run.

After a pod failure, first verify that it has terminated. Recreate only the
Kubernetes Job with the same replay prefix, job ID, manifest hash, image,
configuration, and durable budgets. Keep the original stopped-job marker and
retry counters intact. Saved plans, completed review batches, embeddings, and
finalized output are reused. Ordinary unresolved comparisons retain both
evidence records and are listed in `review-report.json` for later repair.
Source locations are attached to a deep copy of the finalized documents, so a
location-mapping or save failure cannot mutate the pinned review inputs and
change the identities of completed review tasks on retry.

If the indexing HTTP response is lost while the API is still uploading, confirm
that Search/upload telemetry is advancing, then restart the replay coordinator
with `EVIDENCE_REPLAY_WAIT_FOR_INDEX_RECEIPT=true`. This waits up to one hour for
the existing API upload's durable receipt instead of submitting another upload.
Polling happens before the worker checks or increments its processing attempts,
so an extracted job can finish even when its attempts are exhausted. A timeout,
cancellation, or source change leaves the attempt counter untouched. Receipt-wait
mode requires an existing extracted or completed job; it cannot start extraction
or a new upload. It retains the same work record, source fences, and budgets.

Success requires all of the following:

1. `finalized.json` and `review-report.json` are preserved in the replay prefix.
2. The normal ingestion API has saved its indexing receipt, and the replay work
   record is `completed`.
3. `indexed.json` and `completed.json` are present in the replay prefix.
4. A Search query for the source confirms the finalized evidence records and
   their replay `metadata.evidenceJobId`, source citations, and vectors. Account
   for deterministic splitting of oversized records when comparing counts.
5. Both budget ledgers are inspected; report charged usage and outstanding or
   maximum reservations separately.

The replay deliberately retains recovery inputs and does not publish the old
failed ingestion's cleanup or notification event. The replay has its own
completion record; the original failed job remains stopped.

For visible progress during deduplication, run
`monitor-evidence-finalization-replay.mjs` in a companion Job with the same
prefix, manifest checksum, storage settings, and explicit environment telemetry
override. Set `EVIDENCE_REPLAY_BATCH_COUNT` from the saved canonicalization plan.
It reads recovery records and budget ledgers, emits
`EvidenceFinalizationReplayProgress` once per minute, and exits after completion.
It performs no model calls or storage writes. Its observations include the last
saved review timestamp, so a fresh telemetry snapshot does not imply fresh work.
