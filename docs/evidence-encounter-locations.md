# Encounter locations

An encounter's named hospital or clinic can establish the location of its examinations, measurements, treatment, observations, and care handoffs. A continued page does not need to repeat the facility name on every line. The extractor supplies exact facility passages in `locationContext`; gathering and source review must link each item to the applicable encounter and cite the supporting header or passage.

These passages are context, not a global default. Historical incidents, home or school circumstances, outside treatment, generic patient education, planned transfers, and a remote clinician's signature do not inherit the hospital's location. Encounter boundaries and competing facilities must be checked against the source. Unknown remains appropriate when a link is unsupported or ambiguous.

Dates remain specific to evidence kind. A measurement such as “respiratory rate was 20 at 15:04 on December 4” is a fact dated by `asOf`. An admission or treatment occurrence uses `whenStarted`. A chronology consuming both kinds must read both fields. Current calendar-date objects do not encode clock time; the original wording and quotation retain it. A location repair does not change classification or date fields.

## Repairing stored locations

The repair command reviews only `Unknown` locations for one completed ingestion job and one source-named facility. It uses the configured primary model to propose assignments and the independent model to verify them. Both reviewers must agree, and every correction must pass exact source identity, full-record, and quotation checks. Known locations remain intact.

Run from `src/DataIngestionService` with the same settings, storage access, Search identity, and embedding deployment as the service. `loadAppSettings` reads `APPSETTINGS_FILE` or the mounted settings file. The finalizer task ID identifies the completed job; it is distinct from a telemetry process ID.

```sh
bun run repair:evidence-locations --task-id <finalizer-task-id> \
  --facility "Source-named Medical Center" --plan-id encounter-location-sample \
  --sample-per-page 1 --include-record <optional-specific-record-id>
```

Review mode writes no Search documents. It stores the input snapshot, per-batch decisions, independently verified proposals, and a manifest in the private `file-operations-evidence-location-repairs` Blob container under the plan ID. These artifacts contain source evidence and must remain private. Repeating a plan resumes completed batches. Use a different plan ID when changing the source, facility, sample, or review instructions.

After checking a sample, omit `--sample-per-page` with a new plan ID to review all eligible records. Wait for a `reviewed` manifest before applying that plan:

```sh
bun run repair:evidence-locations --task-id <finalizer-task-id> \
  --facility "Source-named Medical Center" --plan-id encounter-location-full --apply
```

Application checks that the original ingestion is still current, regenerates vectors from corrected content, rechecks each record for concurrent changes, and merges by its existing ID. The location, metadata, supporting citations, and page references stay synchronized. Merge cannot recreate deleted records. Per-record receipts allow interrupted application to resume without repeating completed changes. The command preserves original input snapshots for review and recovery.

This maintenance operation does not restart extraction or alter its completed checkpoints. Future extractions use the corrected source-context instructions. Deploy those instructions only after existing evidence tasks drain, because their checkpoint fingerprint changes.
