# Evidence token spending limits

`EVIDENCE_COST_BUDGET_CONFIG` is an optional JSON **string** in appsettings. An
empty string leaves existing behavior unchanged. Configure the same value and
storage connection in the ingestion API and every evidence worker before
restarting a capped source. Each matching ingestion session gets its own limit;
retries of the same evidence job share that limit. The setting bounds token charges for text Responses,
pinned Foundry model-router Responses, Anthropic Messages, and embeddings,
including initial ingestion embeddings, SDK retries, tool rounds, independent
review, repair and indexing.

```json
{
  "version": 1,
  "currency": "USD",
  "validUntil": "2026-10-24T00:00:00Z",
  "pricingSource": "https://prices.azure.com/api/retail/prices",
  "reservationMaxAgeMs": 3600000,
  "limits": [
    {
      "accountId": "YOUR-ACCOUNT",
      "sourceId": "391",
      "budgetId": "approved-restart-2026-10-17",
      "limitUsd": "70"
    }
  ],
  "prices": [
    {
      "origin": "https://YOUR-FOUNDRY.services.ai.azure.com",
      "deployment": "recon-test-gpt-6-luna",
      "kind": "responses",
      "inputUsdPerMillion": "0.25",
      "uncachedInputUsdPerMillion": "0.20",
      "cacheReadUsdPerMillion": "0.02",
      "cacheWriteUsdPerMillion": "0.25",
      "outputUsdPerMillion": "0.75",
      "maxInputTokens": 1050000,
      "maxOutputTokens": 128000
    }
  ]
}
```

Register **every** primary, independent, fallback and embedding deployment, using
the exact HTTPS origin and deployment alias. An unregistered endpoint or model
is blocked before sending the request. For embeddings use `kind: "embeddings"`,
`maxInputTokens: 8192`, and zero output price and output limit. Prices and limits
support up to six decimal places. The example expires deliberately; verify the
deployed model, SKU, region, published prices and token limits before enabling
or extending a configuration. Configuration is loaded at process startup.
`inputUsdPerMillion` remains the highest applicable input category price used
for the pre-request reservation. The optional `uncachedInputUsdPerMillion`,
`cacheReadUsdPerMillion`, and `cacheWriteUsdPerMillion` refine settlement only
when the provider reports those categories. Each must be no higher than the
input ceiling. Unreported categories retain the ceiling. Cache-write rates
should cover the longest enabled cache lifetime.

Use `kind: "router"` for a Responses router and register its fixed underlying
model names in `allowedModels`. Set `inputUsdPerMillion` and
`outputUsdPerMillion` to the highest applicable rates among that pool, including
long-context and cache-write categories; set `routerFeeUsdPerMillion` to the
published additional input-token fee. Pin the model subset and router version in
the infrastructure stack before using a capped source. A router response that
names an unregistered model blocks further requests. Some responses report only
the router alias; those settle at the registered highest rate. `kind: "messages"`
registers a direct Anthropic deployment at the highest applicable uncached or
cache-write rate. Anthropic reports uncached input, cache creation, and cache
read tokens separately; output includes thinking tokens. For OpenAI Responses,
`input_tokens` includes cached tokens; `input_tokens_details.cached_tokens` and
`cache_write_tokens` partition them when supplied. The router fee applies to
all input tokens, including cached input.

The ledger key hashes `{accountId, sourceId, budgetId, sessionId}`, where
`sessionId` is the durable evidence `jobId` created for the ingestion event.
The initial ingestion API call, evidence workers, and retries use that same ID.
A new ingestion event gets a new allowance even when it targets the same
account/source. A pod restart or replay of the same event does not reset its
balance. Budgeted requests missing a session ID fail closed. Another account
with the same source ID has a separate budget. Changing the limit or registered
prices for an existing session fails closed; extending the verified price
expiry does not reset its balance.

Set `EVIDENCE_BUDGET_PREFLIGHT_CONFIG` in appsettings to a JSON string such as
`{"estimatedThoroughUsdPerPage":"2.5","referenceCharactersPerPage":4000}`.
The old build ignores this separate setting, so it can be staged before a
deployment. When configured, thorough mode estimates cost as the larger of
the source page count and `ceil(characterCount / referenceCharactersPerPage)`,
multiplied by `estimatedThoroughUsdPerPage`. If that exceeds the session's
remaining balance, the job saves `fast` mode before starting evidence reviews.
The estimate is a routing heuristic, not a charge or a guarantee of completion;
fast mode still observes the hard cap. Set the page price from observed costs
for the deployed model mix and review it as prices or prompts change. Explicit
`evidenceExtractionMode: "thorough"` is also routed to fast when its estimate
exceeds the remaining balance.

An authenticated gateway ingestion request can set
`"evidenceBudgetOverride": true` to keep its requested/automatic mode and
allow model spending beyond the configured hard cap. The saved work carries
this flag through all retries and queued reviews. Use it only for an intentional
uncapped run. `EVIDENCE_STOPPED_SESSION_IDS` is an optional JSON array of job
IDs that always remain stopped, including if a request had an override. Set it
before deploying a session-scope migration if an older source-wide job was
stopped but still has queued tasks.

## Reservation and failure behavior

Before each provider HTTP attempt, a conditional blob write reserves its maximum
cost. ETags serialize admission across workers. The ledger resides in
`file-operations-evidence-budgets` using
`EVIDENCE_QUEUE_STORAGE_CONNECTION_STRING`, falling back to
`BLOB_CONNECTION_STRING`. Amounts are integer microdollars, rounded upward.
Reservations use the smaller of the documented maximum input size and twice
the serialized request's UTF-8 byte length plus 65,536 input tokens, with an
explicit output token limit. The byte bound includes text, tool schemas and
request framing; the extra allowance covers provider framing and tokenization.
Responses requests that reference server-side conversation or prompt state,
and Messages requests with a server-side container, retain the full documented
input bound because the submitted body does not contain all billable context.
An embedding batch is also capped by its per-input token maximum.

Confirmed usage replaces the reservation with a charge at the registered
category rates. Reasoning tokens are already included in output usage and are
not counted twice. Router calls add the input-token routing fee. An HTTP 400
response explicitly coded `content_filter` rejects the prompt before output is
generated; it settles at the bounded full input rate, including the router fee,
and records `settlementKind: "rejected-input"`. Other unsuccessful responses,
lost responses and missing or invalid usage consume the full request-sized
reservation. A crash or lost storage
acknowledgement keeps the reservation; after `reservationMaxAgeMs` (default one
hour), it becomes a full charge, **never a refund**. Late usage cannot undo that
charge. A reported token-bound violation blocks further requests.
Each new ledger entry records `settlementKind: "usage"` for a provider-reported
settlement, `"rejected-input"` for a confirmed prompt rejection, or `"maximum"`
for an uncertain full charge. An outstanding entry
has no `chargedMicros`; expired entries also have `abandoned: true`. Older
ledgers predate `settlementKind`, so their full-maximum charges can only be
inferred by comparing `chargedMicros` with `reservedMicros`. The total charged
against the cap is a conservative exposure ceiling, not an Azure bill estimate.

When outstanding requests hold the remaining balance, queued tasks wait without
consuming retry attempts. Storage failures also block provider requests and
remain retryable. Once committed spending cannot fund another bounded request,
the ledger records a permanent stop. Queued workers emit
`EvidenceTaskBudgetStopped` and retain failed task manifests/poison notifications.
Inline workers retain the event in failed-event storage and emit
`EvidenceExtractionBudgetStopped`. Both preserve input files and checkpoints;
neither publishes failed cleanup or escalates the budget error to another model.
The indexing API preserves budget error codes in HTTP 402 responses.

In-flight requests already hold reservations and can finish after the stop.
The allowance includes them. No ledger is deleted by source cleanup or task
pruning. Keep budget ledgers for as long as broker replay or operator requeue is
possible. To inspect spending, sum `chargedMicros ?? reservedMicros` over the
ledger's `entries` and divide by 1,000,000; the result includes outstanding costs.
`blocked` identifies a permanent spending stop. The ledger contains identities
and amounts, without source text or model output.

Streaming, background responses, priority tiers, provider-hosted tools and
multimodal requests are blocked for capped sources because their charges are
outside this implementation's bound. Other provider protocols also remain
blocked. Ordinary uncapped requests retain their existing behavior. This is a token-spending
ceiling based on the configured rates and model bounds; taxes, storage, search,
Content Understanding and other infrastructure charges are outside it. Incorrect
or stale price/token limits cannot provide a billing guarantee.

## Previous GPT-only Test rates, October 17, 2026

The retail meter snapshot (operational record retained privately)
records the applicable Azure GlobalStandard meters. ARM deployment metadata
confirmed both `tasks-gpt-6.0-luna` and `recon-test-gpt-6-luna` use `gpt-6-luna`,
and `research-gpt-6.1-sol` uses `gpt-6.1-sol`. The registered rate uses the highest
short/long-context input/cache-write category and output category, without
assuming cache savings.

| Deployment | Input USD / million | Output USD / million | Maximum reservation / response |
| --- | ---: | ---: | ---: |
| `tasks-gpt-6.0-luna` | 0.25 | 0.75 | $0.3585 |
| `recon-test-gpt-6-luna` | 0.25 | 0.75 | $0.3585 |
| `research-gpt-6.1-sol` | 5.00 | 15.00 | $7.17 |
| `pbl-query` (`text-embedding-3-large`) | 0.13 | 0 | $0.001065 per input |
| `pbl-partitioning` (`text-embedding-3-small`) | 0.02 | 0 | $0.000164 per input |

The documented model context is 1,050,000 tokens with up to 128,000 output tokens;
reserving the whole context as input is deliberately conservative. A $70 cap
can stop below $70 of actual Azure charges, especially after ambiguous research
responses. It does not promise that extraction will finish within the allowance.

The earlier GPT-only restart configuration used
`EVIDENCE_RECONCILIATION_DEPLOYMENT_NAME=recon-test-gpt-6-luna`,
`EVIDENCE_RECONCILIATION_PROVIDER=openai`,
`EVIDENCE_RECONCILIATION_REASONING=xhigh`, and
`EVIDENCE_RECONCILIATION_FALLBACK=independent`. That configuration has been
superseded by the pinned router mix below. Model settings apply to Test workers
globally; coordinate the rollout with other active jobs.

### Pinned Test router mix

The completed 15-page local comparison used the Cost router for primary
gathering, direct Claude Sonnet 5.5 for independent gathering, and the Balanced
router for reconciliation. It finished in 18m42s, including 8m33s gathering.
The earlier Claude mix took 38m10s and the original GPT run took 27m37s; these
were separate runs under shared Azure traffic, not a controlled latency study.
All 2,827 returned citations had exact source offsets, but differing record
counts do not prove equivalent evidence recall. The price snapshot (operational record retained privately)
contains the published GlobalStandard meters used for the cap.

| Deployment | Guard input ceiling / million | Guard output ceiling / million | Router fee / million input |
| --- | ---: | ---: | ---: |
| `fast-tasks-model-router` (pinned Luna) | $0.50 | $1.80 | $0.14 |
| `utility-model-router` (pinned Sol/Terra) | $10.00 | $30.00 | $0.14 |
| `research-claude-sonnet-5-5` | $4.00 | $10.00 | none |

The router entries use the highest long-context standard Global input or
cache-write rate and output rate in each pinned subset. Sonnet uses its higher
one-hour cache-write rate for every input token; its default GlobalStandard
deployment avoids the US Data Zone multiplier. Requests are capped at 16,384
output tokens, matching the local benchmark, and the guard reserves the full
documented context input size. This deliberately spends the allowance faster
than Azure's likely bill. Changes to any pinned model, SKU, deployment version,
or published meter require a new verified price configuration before another
capped run.

The subsequent Test routing uses `fast-tasks-model-router` for first-pass
reconciliation, `utility-model-router` only for reconciliation fallback, and
`tasks-claude-haiku-5-5` for independent gathering. The source 391 ledger is
already blocked under its original $70 allowance; changing model settings does
not reopen it. Verify and register Haiku's price and token bounds before
starting a *new* capped run with this mix. Adding that price to the existing
budget configuration changes its fingerprint and does not reset or extend the
old ledger.

## Validation

Unit tests cover concurrent reservations, rollover prevention, lost responses,
expired pricing, integer rounding, corrupt ledgers, abandoned reservations,
bound violations and budget propagation through API, queue, inline and review
paths. Local Azurite tests exercise ETag contention between independent blob
clients and the actual Azure embedding SDK transport. No paid model calls are
needed. Run the service suite with `EVIDENCE_QUEUE_AZURITE_TESTS=1` against the
local-only endpoints specified in `evidenceCostBudget.test.ts`.
