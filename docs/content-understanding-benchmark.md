# Azure Content Understanding evidence benchmark

**Status: closed without a live comparison, October 11, 2026.** The maintainer
decided to use Content Understanding for the Document Integrity service and to
exclude it from Evidence Extraction. The implementation and preparation records
below are retained for reference; they are not an active integration plan.
Data Integrity adoption is implemented separately in the
[extraction migration](content-understanding-migration.md); this archived
candidate-extraction comparison remains closed.

This standalone benchmark compares Content Understanding with the existing
Evidence Extractor. It uses the GA `2025-11-01` API and the existing candidate
schemas, reconciliation, event annotation and canonicalization. It does not
change production ingestion. A successful service call or a larger record count
does not establish better evidence quality.

## Comparisons

| Arm | Extraction input | Candidates sent to the existing review pipeline |
| --- | --- | --- |
| `baseline` | Frozen Document Intelligence Markdown | Saved primary and independent candidates |
| `cu` | The same Markdown bytes, submitted to a custom CU analyzer | CU candidates with validated citations |
| `supplement` | The same Markdown bytes | The unchanged baseline candidates plus CU candidates |
| `layout` | Original PDF, converted by a CU analyzer with OCR/layout and no generated fields | Fresh primary and independent extraction from the frozen CU Markdown |

The candidate comparison isolates the source representation. CU sees the whole
Markdown document; the existing extractor works in windows with source tools.
Those context strategies differ. The layout comparison requires fresh extraction
because its source text and offsets differ. Adding candidates changes review
batches; model nondeterminism remains even with identical configurations.

The saved NTSB RIR-25-08 document is now a **development regression source**:
examples from it were inspected and used in subsequent development. Its 33
provisional reference propositions are not an exhaustive gold inventory. A new
document, frozen before tuning, is needed for a held-out quality claim. The
October 10 full extraction remains the historical comparison reference.

## Prepare a frozen fixture

Run commands from `src/DataIngestionService`. Paths in the fixture resolve
relative to the fixture file. Keep source documents, results and settings in a
private directory such as `.local/`, outside version control.

```json
{
  "version": 1,
  "evaluationStatus": "development-regression",
  "source": {
    "id": "document-id",
    "title": "Document title",
    "markdown": "source.md",
    "sha256": "SHA256_OF_MARKDOWN_BYTES",
    "pdf": "source.pdf",
    "pdfSha256": "SHA256_OF_ORIGINAL_PDF"
  },
  "baseline": {
    "candidates": "saved-candidate-directory",
    "provenance": "Date and configuration that produced these raw candidates"
  },
  "contentUnderstanding": {
    "completionModel": "gpt-5.2",
    "modelDeployments": {"gpt-5.2": "YOUR_EXISTING_DEPLOYMENT"},
    "processingLocation": "geography"
  }
}
```

`completionModel` is a **supported model name**; `modelDeployments` maps it to
an existing Foundry deployment name. Verify availability in the selected
resource. The runner checks the base analyzer's `supportedModels`, snapshots
effective deployment mappings, and supplies them in each analysis request.
It does not modify resource-wide defaults or provision model deployments.
If Azure returns `DefaultsNotSet`, explicit request mappings are still used;
other API failures remain errors.

Omit `baseline.candidates` to capture fresh candidates. Saved candidates must
use the extractor's `EvidenceCandidateSnapshotStore` format, with one file per
window and matching source/window hashes.

```bash
bun run benchmark:content-understanding --input FIXTURE.json --output RUN_DIR --stage prepare
```

Preparation makes no provider calls. It validates source and candidate hashes
and writes a manifest containing analyzer definitions, API version, dependency,
implementation, runner and runtime skill fingerprints. Changing any of those
requires a new output directory. Reference answers are read only by `report`.

The local NTSB fixture is
`.local/content-understanding-benchmark-2026-10-11/fixture.json`. It freezes
seven pages, seven windows and 425 existing raw candidates. The fixture's model
name is an explicit starting configuration; a live run still requires a resource
with a supported mapped deployment.

## Run individual stages

Live stages require `--live --settings SETTINGS.json`. Settings use the existing
`AZURE_OPENAI_*` and `EVIDENCE_*` model configuration keys. Add
`CONTENT_UNDERSTANDING_ENDPOINT`, the root HTTPS endpoint of a Foundry resource.
For CU authentication, the runner uses `CONTENT_UNDERSTANDING_API_KEY` if present,
otherwise `DefaultAzureCredential`. Settings are not copied into results.

Keep `EVIDENCE_CANONICALIZATION_MODE=review` and
`EVIDENCE_EVENT_STRUCTURE_MODE=annotate`. The same pipeline configuration is
required across all arms, including deployment, reasoning and token limits.
The benchmark uses the configured reconciler; it does not assume it is Sol.

| Stage | Purpose |
| --- | --- |
| `cu-candidates` | Create/reuse a definition-hashed custom analyzer; analyze frozen Markdown; normalize candidates |
| `cu-layout` | Create/reuse a layout-only analyzer; analyze the original PDF; freeze physical-page Markdown |
| `capture-baseline` | Capture primary/independent candidates if the fixture does not already supply them |
| `capture-layout` | Capture fresh primary/independent candidates from the saved CU layout |
| `replay --arm baseline` | Review the frozen baseline candidates |
| `replay --arm cu` | Review the normalized CU candidates |
| `replay --arm supplement` | Review baseline plus CU candidates |
| `replay --arm layout` | Review candidates extracted from CU layout |
| `report` | Produce an offline comparison and review packet |

For example:

```bash
bun run benchmark:content-understanding --input FIXTURE.json --output RUN_DIR --stage cu-candidates --live --settings SETTINGS.json
bun run benchmark:content-understanding --input FIXTURE.json --output RUN_DIR --stage replay --arm baseline --live --settings SETTINGS.json
bun run benchmark:content-understanding --input FIXTURE.json --output RUN_DIR --stage replay --arm cu --live --settings SETTINGS.json
bun run benchmark:content-understanding --input FIXTURE.json --output RUN_DIR --stage replay --arm supplement --live --settings SETTINGS.json
bun run benchmark:content-understanding --input FIXTURE.json --output RUN_DIR --stage cu-layout --live --settings SETTINGS.json
bun run benchmark:content-understanding --input FIXTURE.json --output RUN_DIR --stage capture-layout --live --settings SETTINGS.json
bun run benchmark:content-understanding --input FIXTURE.json --output RUN_DIR --stage replay --arm layout --live --settings SETTINGS.json
bun run benchmark:content-understanding --input FIXTURE.json --output RUN_DIR --stage report
```

These are separate stages so the caller controls spend and experiment order.
Only two custom analyzers are created per set of definitions. Creation uses
`allowReplace=false`; an existing analyzer with different settings is rejected.

The CU client saves the operation URL before polling. Polling has a 15-minute
deadline, 30-second request timeouts and at most two consecutive transient GET
retries. Repeating the stage resumes a saved operation. It does not automatically
resubmit failed analyses or POSTs whose outcome is unknown. The pipeline stores
completed windows and review stages locally, with candidate-set hashes in
checkpoint identity. Failed attempts and their usage remain in the results.
Incremental event logs recover measured usage after an interruption; total cost
and elapsed time remain unknown when reporting may be incomplete.

To import an archived response without calling Azure, supply its matching
`candidates.receipt.json` or `layout.receipt.json`:

```bash
bun run benchmark:content-understanding --input FIXTURE.json --output NEW_RUN_DIR --stage cu-candidates --response SAVED_RESPONSE.json --receipt SAVED_RECEIPT.json --encoding utf16
```

Receipts bind the response hash to the input hash, analyzer definition, API
version and encoding. They record the runner's request provenance; they are not
a service-signed attestation. An arbitrary raw response without that provenance
is insufficient for an input-controlled comparison.

## Grounding and acceptance

The analyzer schema is derived from the production event/fact/claim validators.
CU's field schema is converted explicitly; it is not treated as JSON Schema.
Primary and supporting quotation fields use `extract` with source grounding.
Unknown date parts remain null instead of receiving invented precision.

The adapter checks quotation spans against CU's Markdown in UTF-16 units, then
locates the quotation independently in the canonical source. Only exact text
with reversible whitespace differences is accepted. It stores the **canonical
page-local offset and actual canonical quotation**. CU offsets and generated page
numbers are not copied. Repeated quotations, absent or inconsistent grounding,
invalid required fields and quotations crossing extraction-window boundaries
are quarantined in `cu.normalization.json` for review. Missing category arrays
are reported as incomplete extraction, rather than silently becoming zero items.
Confidence values are retained as service metadata, not truth probabilities.

For the layout arm, physical page boundaries come from page spans in the response.
Overlaps, discontiguous spans, missing pages and non-whitespace text outside page
spans cause validation failure. Generated figure descriptions are disabled.
Exact text matching cannot establish that OCR correctly represents the PDF.

## Review and metrics

`report.json` includes record counts by kind, every invalid citation, trigger and
role coverage, normalization rejections, model-call usage, repair/rejection
events, and observed unchanged/corrected/split/unsupported decision proposals.
Proposal counts include retries and are not final accepted-correction counts.
`review-records.json` includes full records and citations for source review.

Use a separate reference file with `pdfSha256`, `exhaustive`,
`humanAdjudicated`, and `units: [{id, kind, statement, ...sourceReferences}]`.
Pass it to `report --reference REFERENCE.json` to bind its hash into the review
packet. Copy the packet to a separate judgments file before filling in each
record's `supported`, `classificationCorrect`, `citationSupported`, `atomic`
booleans and `unitIds`. Pass that file with `--judgments JUDGMENTS.json`.
Remove unreviewed records from the judgments file; null judgments are rejected.
The generated packet is refreshed by `report`, so do not edit it in place.

Coverage counts distinct reference units once. One atomic record can cover at
most one independently useful unit; bundled recommendations cannot claim several
units of recall. A record receives coverage credit only when support,
classification, citation and atomicity judgments all pass. Recall is reported
only for an exhaustive, human-adjudicated reference with every output reviewed.
Otherwise the result is labeled reference coverage, and recall stays null.
Judgments are bound to the manifest, reference and individual arm output hashes.

## Timing and cost

The runner requests GA diagnostics with `x-ms-diagnostics: true` on every poll.
Raw `usage`, warnings and diagnostic `infos` are retained. Diagnostic messages
are human-readable and are not parsed as a stable token accounting interface.

Supply `--rates RATES.json` for price estimates. It contains separate
`contentUnderstanding`, `pipeline` and `documentIntelligence` objects, each with
`currency`, `asOf`, and a `meters` map. Each entry is `{ "price": NUMBER,
"per": NUMBER }`. Rates must come from the applicable deployment/service price
schedule. CU meter names are the flattened usage keys, such as
`documentPagesBasic`, `contextualizationTokens` and `tokens.gpt-5.2-output`.
Pipeline meter names are `models.DEPLOYMENT.input`, `.cachedInput`, `.cacheWrite`
and `.output`. Uncached input excludes cache reads/writes; reasoning is already
part of output and is not charged twice.

For historical candidates, optional `baseline.captureMetrics` points to a file
containing `elapsedMs`, `usageComplete: true`, and `usageMeters` in the pipeline
format. Optional `baseline.parsing` supplies `elapsedMs` and `usageMeters` for
the original Document Intelligence conversion. Keep their provenance with the
fixture. Missing historical measurements stay unknown.

Each arm's total includes its parsing, candidate extraction and downstream review
components. Shared saved work is included in each arm's standalone estimate;
do not sum those arm totals to estimate experiment spend. Missing usage, missing
rates or interrupted telemetry leave total cost null and retain known subtotals.
These estimates are not Azure invoices. CU may add cost even when it reduces
downstream corrections.

## Microsoft references

Checked against the published documentation on October 11, 2026:

- [API versions and capabilities](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/overview)
- [Analyzer and field schema](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/concepts/analyzer-reference)
- [Model support and deployment mappings](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/concepts/models-deployments)
- [Document spans and physical pages](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/document/elements)
- [Analyze request and response](https://learn.microsoft.com/en-us/rest/api/contentunderstanding/content-analyzers/analyze?view=rest-contentunderstanding-2025-11-01)
- [Diagnostics](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/how-to/retrieve-diagnostics)
- [Pricing model](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/pricing-explainer)
