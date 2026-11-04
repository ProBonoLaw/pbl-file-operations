# Evidence extraction and RAG retrieval

Claims, facts, and events are already embedded as readable evidence documents in
the account's Azure AI Search index alongside ordinary source chunks. The queue
workflow indexes source chunks first, then adds evidence after review, repair,
consolidation, and citation validation finish. A pending review does not publish
partially validated evidence.

In queue mode, the coordinator queues windows for `evidence-gather`, which runs
three window tasks concurrently and hands durable candidate batches to the independent
`evidence-reconcile` worker. It can proceed to later pages without waiting for
source review, and the source worker starts review/repair tasks as its plans finish.
The subsequent [live queue benchmark](evidence-async-review.md#live-benchmark-with-separate-gathering-and-source-queues)
completed gathering in 18m04s and the full evidence pipeline in 38m13s, versus
34m28s and 43m36s previously. Retrieval-field projection and 5,164 exact citations
passed local validation; this test did not write to Azure AI Search. The later
[3/5 concurrency run](evidence-async-review.md#live-benchmark-with-reconciliation-three-and-repair-five)
completed in 26m30s (1m46s per page), with 1,993 evidence records and 4,731 validated
citations. Conversion, embeddings, and Search indexing remain outside these timings.

## Avoid unnecessary repair

The 15-page replay with four repair slots took 29m35s: source-support review took
28m42s and the remaining review/repair and consolidation tail took 53s. The next
optimization targets avoidable work in source review rather than increasing
repair capacity again.

Review responses sometimes omit unused `corrections`, `events`, `facts`, or
`claims` lists. The application now treats absent lists as empty before validating
each decision. This avoids sending an otherwise valid unchanged decision to
repair solely for missing empty arrays. Explicit nulls, wrong types, unknown
verdicts, duplicate/missing candidate IDs, and inconsistent payloads still fail.
A supported decision with `keepOriginal=false` must supply an actual correction
or replacement. Dates, classifications, and exact source citations still undergo
the existing checks. Checkpoint fingerprints change with this implementation.

This is a deterministic response-handling improvement, not a measured reduction
from the 29m35s baseline. The subsequent complete pipeline run with fresh medium
gathering finished in 43m36s; see [the full run results](evidence-async-review.md#complete-evidence-pipeline-with-medium-gathering).
A matched replay is still needed to isolate this change's effect on latency and
semantic quality. Compare source-review valid/invalid counts,
repair dispatches, source phase time, total time, token usage, and citation checks.

## Search fields

New ingestion projects these fields from the validated evidence metadata:

| Field | Retrieval use |
| --- | --- |
| `evidenceKind` | Exactly `event`, `fact`, or `claim`; null for ordinary chunks. Events also carry a legacy `fact` tag, so use this field to distinguish kinds. |
| `eventType`, `factType`, `claimType` | Filter or facet by the kind's classification. |
| `claimant`, `claimPolarity` | Keep statements attributed and preserve `asserts`, `denies`, and `uncertain`. |
| `subject`, `reportedBy` | Distinguish who a recorded fact concerns from who reported it. |
| `sourceContentHash` | Identify the source revision supporting the evidence. |

The existing `sourceId`, `pages`, `who`, `asOf`, `whenStarted`, `whenEnded`, and
`evidenceExtractionMode` fields remain available. Full `sourceSpans`, offsets,
quotations, date uncertainty, and event roles remain in returned `metadata`.
Source text and embedding content remain aligned. Adding retrieval fields alone
does not require new embeddings.

Index migration adds missing fields using the existing ETag retry mechanism and
preserves semantic/vector configuration. Incompatible existing fields fail with
their field name instead of silently providing incorrect filtering.

## Use evidence with source retrieval

The answering/retrieval application is outside this repository. Its integration
should query the authorized account index and combine two bounded result sets:
ordinary chunks for context and evidence for specific statements. Use hybrid
text/vector search over `content` and `content_vector`, followed by the index's
semantic ranker. Embed the user's query using the same deployment and dimensions
as ingestion. Reserve results for both sets so thousands of evidence records do
not crowd out surrounding source context.

Example OData filters, combined with the caller's source/access scope:

| Intent | Evidence filter |
| --- | --- |
| Occurrences and timeline candidates | `evidenceKind eq 'event'` |
| Recorded assessments for Casey | `evidenceKind eq 'fact' and subject/any(s: s eq 'Casey')` |
| What Alex denied | `evidenceKind eq 'claim' and claimant eq 'Alex' and claimPolarity eq 'denies'` |
| All attributed assertions and counterclaims | `evidenceKind eq 'claim'` |
| Surrounding document chunks after migration | `evidenceKind eq null` |

Use the SDK's filter escaping or escape apostrophes in string literals; do not
concatenate unescaped user input into filters. Include `id`, `content`,
`evidenceKind`, `sourceId`, `pages`, `metadata`, and relevant attribution/date
fields in selected results. Preserve each result's ID for citations. Use
`sourceId` and cited pages to retrieve surrounding source chunks when needed.

An extracted fact means the source records that fact; it is not an independent
finding of real-world truth. Keep a claim's speaker, polarity, modality, and
supporting quotations in the answer context. A denial is not proof the alleged
event did not happen. Retrieve opposing claims rather than deduplicating them by
shared topic. Timeline consumers must honor `eventDateResolution` in metadata;
partial dates and possible date bounds must not become invented exact dates.

## Populate existing records

Adding index fields does not populate older rows. Run the existing source-scoped
backfill under its new alias to preview updates:

```bash
bun run backfill:evidence-search --settings /path/to/appsettings.json \
  --endpoint https://SEARCH.search.windows.net --index ACCOUNT_INDEX \
  --source-id SOURCE_ID --output /path/to/report.json
```

The default preview performs no writes or embedding requests. `--apply` adds the
schema and merges fields into existing record IDs; `--limit N` bounds updates.
Run with `--apply` while ingestion/removal is paused for the selected source, as required
by the existing backfill's concurrency contract. Unchanged content retains its
vector, while older content formats use the existing content/embedding migration.
The backfill rechecks records before writing, skips unsupported fragments/schema
versions, and skips completed rows on rerun. It never invokes evidence extraction.

Until backfill completes, older evidence has null `evidenceKind`; it cannot yet
be reliably separated from chunks using that field. Deploy the ingestion changes
and complete the backfill before making evidence-only filters mandatory in the
answering application. No deployed index or answering application is changed by
the repository update itself.

## Validation

The local regression suite passed 953 tests; two optional Azurite tests were
skipped. Build and lint passed. Recovered-response tests verify that omitted lists
avoid redundant repair while malformed verdicts, explicit nulls, missing
replacements, and contradictory payloads still go to repair.

An offline migration check covered all 2,096 records from the 15-page replay:
211 events, 896 facts, and 989 claims. Every record received its retrieval fields
without changing content or source citations, zero embeddings were needed, and
rerunning marked every record current. This check made no live model calls or
Search writes. Private results are in
`.local/evidence-performance-rag-validation-2026-10-13/projection-audit.json`.
