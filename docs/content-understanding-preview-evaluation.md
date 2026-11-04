# Content Understanding `2026-06-01-preview` evaluation

Evaluated October 12, 2026 against GA `2025-11-01`, using the implementation at
`d24cc189c1572d94ef609bbcab7f8aa3b2813844` and the existing Test Foundry and Azure
AI Search resources. **Maintainer decision, October 12, 2026: stay with GA
`2025-11-01` for now; defer preview adoption and compatibility implementation.**
The findings below are retained for a future evaluation.
Preview adds useful signature detection and embedded document
metadata, but a version change alone rejects every response. After accommodating
the API provenance value offline, signature Markdown still prevents publication
of the signed contract. This evaluation does not establish a RAG quality gain.

The work concerns Data Integrity extraction and Data Ingestion's source chunks.
It does not reopen the archived Content Understanding candidate/evidence
extraction comparison. Application code, mounted appsettings, resource defaults,
and model deployments were unchanged. Test still uses GA CU for documents and
audio, and Video Indexer for video.

## Method and compatibility

Eight synthetic inputs were analyzed once with each API: the same rendered DOCX,
PPTX, and image-bearing XLSX PDFs; a signed two-page contract; a one-page chart;
a native image-bearing XLSX; and matching 7.597-second WAV/MP4 recordings.
Original/analyzed byte hashes, analyzer definitions, raw results, usage, operation
receipts and result images were retained locally. Only synthetic files were sent.
These are development fixtures, not a representative or held-out legal corpus.

Both versions used the existing `prebuilt-documentSearch`, `prebuilt-audioSearch`
and `prebuilt-videoSearch` analyzers, explicit model alias mappings, UTF-16 spans,
`returnDetails`, and `processingLocation=geography`. Requests set
`allowInputTruncation=false`; the current application's submission omits this
parameter. Analyzer preflight and polling used the version being evaluated.
There were 16 fresh analysis operations. Earlier saved GA results were also
checked locally; the tables below use the fresh runs.

The production adapter requires `result.apiVersion == 2025-11-01`. Consequently,
**all eight unmodified preview responses fail its provenance validation**. To
test output compatibility separately, an offline copy changed only that response
property before invoking the production adapter. Saved packages restore the actual
preview version and original raw response. These packages are compatibility probes;
they do not demonstrate that preview works with the deployed application.

The existing Data Ingestion parser and `extractionChunks` accepted the six preview
packages that passed this probe. A separate offline signature prototype accepted
the contract while preserving coverage checks. Production source was not edited.

## Extraction results

Expected units are predefined fixture strings/numbers. Finding all units is a
regression check, not proof that every feature of an arbitrary document is covered.
Times are submission-to-observed-terminal times, including polling, from one run
per input/version; they are not a latency benchmark.

| Input | GA expected literal units | Preview expected literal units after version probe | GA / preview time | Finding |
| --- | --- | --- | --- | --- |
| DOCX rendered to PDF | 4/4 | 4/4 | 7.6 / 5.0 s | Identical literal text and quotation locations |
| PPTX rendered to PDF | 3/3 | 3/3 | 7.1 / 3.8 s | Identical literal text and quotation locations |
| XLSX with images rendered to PDF | 5/5 | 5/5 | 5.5 / 2.1 s | Worksheet values, `00123`, and photo OCR retained on both sheets |
| Signed contract PDF | 13/13 | Publication rejected; raw Markdown has 13/13 | 7.9 / 3.7 s | New signature link requires explicit coverage support |
| Chart PDF | 9/9 | 9/9 | 9.8 / 4.3 s | Identical literal text; chart values 20/35/50 retained; one figure JPEG in each |
| Native XLSX with images | Publication rejected; raw Markdown has 3/5 | Publication rejected; raw Markdown has 3/5 | 8.2 / 4.2 s | Both omit photo OCR and structured pages |
| WAV | 3/3 phrases | 3/3 phrases | 22.3 / 20.2 s | Identical literal transcript and phrase citations |
| MP4 | 2/3 phrases | 2/3 phrases | 20.7 / 28.0 s | Opening phrase missing in both; eight keyframe JPEGs retrieved in each |

The rendered XLSX fixture includes a hidden sheet and a picture outside a saved
print range. Both pictures appear in the analyzed PDF and their OCR survives both
APIs. CU classifies these pictures as text and returns no figure assets for them.
Passing their OCR check does not mean their original image pixels accompany Search
chunks; retained crops remain conditional on CU returning image artifacts.

Keep DOCX/PPTX and image-bearing XLSX PDF conversion. Preview's native XLSX support
does not solve image OCR or the current adapter's requirement for page-based
citations. The native response has `returnDetails=true` but no structured pages,
paragraphs or table arrays, so the adapter's suggestion to enable details is
misleading for this case. Native DOCX/PPTX and other spreadsheet layouts were not
tested. CSV continues through the existing local text parser and was not submitted
to CU; changing the CU API does not change CSV support.

The matching video/audio recordings demonstrate that successful CU media processing
does not guarantee complete transcription. Keep Video Indexer for video until the
opening-phrase omission is resolved and broader media cases pass.

## New document behavior

**Signatures.** Preview returns one signature region in the contract and no
signature for the blank approval line. Its Markdown includes
`![Juesca](signatures/1.1)`, with associated OCR paragraph text `Juesca`; the printed
name `Jane Example` is a separate paragraph. Signature OCR is not reliable identity
evidence. The production coverage check rejects the link at UTF-16 offset 421.
Production image discovery, download path validation, and the TypeScript asset
schema also recognize only `figures/...` and `keyframes/...`.

The offline prototype recognizes only a matching signature ID and exact supported
link syntax. It accounts for the link's formatting while requiring independent
literal coverage of the alt text. It retains the signature as an artifact with
page/region provenance, separate from quotation text. It recovers all 13 expected
contract units and exactly the GA literal Markdown. Three negative checks reject
uncovered trailing text, uncovered signature alt text, and a mismatched signature
reference. The authenticated preview `files/signatures/1.1` request returns a valid
8,533-byte JPEG. That crop is saved separately; the prototype does not claim the
current ingestion asset schema supports signatures.

**Metadata.** Preview returns a flat string map such as
`contentType`, `pageCount`, `language`, `author`, and `title`. The contract and chart
recover the supplied synthetic PDF author/title. The native XLSX returns only
`contentType` in this fixture; Office author/creation-date coverage is untested.
Metadata is currently retained in the raw response, without a dedicated mapping
to Search fields. Treat embedded metadata as source properties with provenance,
not verified authorship or event dates. PDF rendering can change or omit original
Office properties; preserve those separately before rendering when needed.

**Summaries and semantic chunks.** The GA document analyzer has a generated
`Summary` field. Preview's version of `prebuilt-documentSearch` has no field schema
and returns no document `Summary` in these tests. It instead returns semantic
chunks with `maxTokens=250` and resolved workflow
`standard.2026-06-01-preview`. Its DOCX/PPTX/XLSX chunks each cross both physical
pages. The current ingestion path ignores CU chunks and preserves its local
page/table chunking. Replacing local chunking without mapping every source span
would weaken citation precision. Generated chart representations and media
summaries remain available and continue to require separate generated provenance.

These built-in analyzer differences mean the comparison includes changes in
analyzer defaults, not just an HTTP API contract change. Fewer document-generated
fields also explain part of the observed time/usage reduction.

## Azure AI Search retrieval

The production `parseExtractionPackage` and `extractionChunks` functions produced
three isolated evaluation corpora. The existing `text-embedding-3-large` deployment
generated 3,072-dimensional embeddings using the application's embedding API
version, `2024-12-01-preview` (separate from the CU version). HNSW cosine parameters
matched the application: `m=4`, `efConstruction=400`, `efSearch=500`.

Eighteen synthetic queries tested source-specific text, worksheet image OCR,
contract clauses/table amounts, chart labels, and timed transcript phrases.
Labels were written for known fixture content without tuning the extraction or
search configuration. A quotation hit requires all expected query strings in an
`extracted` chunk from an allowed source, with the expected page or a media time
range where applicable. Generated descriptions may be relevant retrieval results
but cannot qualify as quotations. This is passage retrieval, not generated-answer
or evidence-review evaluation.

Queries used lexical search over `title,content`, vector search with `k=50`, and
their hybrid combination, each returning at most ten results. Evaluation titles
and a reduced index schema were used; semantic reranking was not enabled. The tiny
corpus and repeated phrases limit conclusions. The native XLSX was excluded from
all indexes because both adapters reject it.

| Arm | Sources / chunks | Hybrid quotation hit @3 | Hybrid quotation hit @10 | Hybrid quotation MRR @10 |
| --- | --- | --- | --- | --- |
| GA with current adapter | 7 / 21 | 18/18 | 18/18 | 0.685 |
| Preview after version probe, current coverage handling | 6 / 12 | 11/18 | 11/18 | 0.528 |
| Preview with offline signature prototype | 7 / 16 | 17/18 | 18/18 | 0.755 |

The version-only preview arm loses the whole contract, accounting for its seven
failed contract queries. The signature prototype restores those passages; one
transport-amount query places the citable table fourth instead of third. Its higher
MRR is a development observation, not a measured production improvement. Literal
extraction is unchanged for the accepted sources, while removal of document
summaries changes the competing retrieval chunks. Evaluate a custom generated
summary only if a broader corpus shows that its retrieval benefit justifies it.

Full lexical, vector, hybrid metrics and per-query ranks are in the
sanitized evaluation record (operational record retained privately);
the query labels (operational record retained privately)
define the checks. The run embedded 41 unique document/query strings, consuming
1,243 reported embedding tokens. No existing Search indexes were modified; all
three evaluation indexes were deleted after results were saved.

## Usage and migration requirements

All six preview document operations reported page usage. The five without chart
analysis reported no contextualization/model token entries. The chart reported
1,000 contextualization tokens and 1,186 input / 175 output model tokens, compared
with GA's 1,000 contextualization tokens and 4,779 input / 339 output tokens. Media
hours and contextualization counts matched; model outputs varied. Missing usage
entries and one synthetic run do not establish invoice cost savings. Agentic
workflow, synchronous Read/Layout, custom training/classification, large-file
limits and truncation behavior were not exercised.

If preview adoption is reconsidered, complete these prerequisites before a Test
rollout:

1. Add a validated `CONTENT_UNDERSTANDING_API_VERSION` setting, defaulting to GA.
   Use the selected version consistently for analyzer preflight, submission,
   response provenance, asset downloads, package/cache identity and feedback
   identity. Persist version context in operation recovery so a deployment change
   cannot reinterpret an in-flight operation or download its files with the wrong
   API. Increment configuration identity when relevant settings change.
2. Implement explicit signature span/reference validation and artifact mapping
   while preserving coverage rejection for unexplained text. Extend private Blob
   image retention and the ingestion asset schema for `signatures/...`, with the
   existing bounded authenticated download and page/region association rules.
   Signature presence/regions remain distinct from verified signer identity or
   authenticity and from literal quotation evidence.
3. Preserve original document properties separately from analyzed-rendition
   metadata. Map useful fields to ingestion/Search only with explicit source
   provenance. Decide whether generated document summaries are needed; retain
   local source-aware chunking until CU chunks have equivalent citation mapping.
4. Keep PDF conversion and the local CSV route. Fail clearly for unsupported
   native spreadsheet quotation mapping. Explicitly disable input truncation and
   verify rejection for over-limit sources before claiming complete ingestion.
5. Repeat the comparison on a frozen, representative legal corpus with negatives,
   scans, signatures, merged/wide tables, embedded photos, multilingual text,
   long/multi-speaker media and difficult speech. Require no literal/citation
   regressions and agreed retrieval, throughput and cost targets. Keep video on
   Video Indexer until its transcription completeness gate passes.

All 16 evaluation source blobs were deleted only after their operations reached
terminal success, including the two inputs whose adapters rejected publication.
Local raw results and synthetic crops remain under `.local/cu-preview-evaluation/`.
The Key Vault appsettings version remained unchanged during this evaluation.

Microsoft currently recommends GA for production and describes this API as public
preview. The concrete blockers here are also present regardless of that guidance:
the deployed provenance constant, signature coverage/asset support, and unresolved
video completeness.

## Microsoft references

- [Content Understanding release notes](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/whats-new)
- [Document signatures](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/document/elements#signatures)
- [Document metadata](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/document/elements#document-metadata)
- [Analyze REST contract, `2026-06-01-preview`](https://learn.microsoft.com/en-us/rest/api/contentunderstanding/content-analyzers/analyze?view=rest-contentunderstanding-2026-06-01-preview)

References and live analyzer definitions were inspected on October 12, 2026.
