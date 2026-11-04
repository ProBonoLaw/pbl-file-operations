import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareEvidenceContentUpdate } from "../src/processors/evidence/evidenceBackfill.ts";

const mocks = vi.hoisted(() => ({
  options: {} as Record<string, unknown>,
  readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(),
  getIndex: vi.fn(), createOrUpdateIndex: vi.fn(),
  search: vi.fn(), getDocument: vi.fn(), mergeDocuments: vi.fn(), embedQuery: vi.fn(),
}));
vi.mock("node:util", async importOriginal => ({ ...await importOriginal<typeof import("node:util")>(), parseArgs: () => ({ values: mocks.options }) }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir }));
vi.mock("@azure/identity", () => ({ DefaultAzureCredential: class {} }));
vi.mock("@azure/search-documents", () => ({
  SearchIndexClient: class { getIndex = mocks.getIndex; createOrUpdateIndex = mocks.createOrUpdateIndex; },
  SearchClient: class { search = mocks.search; getDocument = mocks.getDocument; mergeDocuments = mocks.mergeDocuments; },
}));
vi.mock("@langchain/openai", () => ({ AzureOpenAIEmbeddings: class { embedQuery = mocks.embedQuery; } }));

const original = {
  id: "original-id", content: "Fact - A score was 65.\nSource page: 1\nSource quote: Score: 65",
  metadata: JSON.stringify({ what: "A score was 65.", tags: ["fact"], factType: "assessmentResult",
    asOf: { year: "2025" }, evidenceSchemaVersion: "3",
    sourceSpans: [{ pageNumber: 1, sourceOffset: 0, sourceQuote: "Score: 65" }],
  }),
};
const index = { name: "test-index", fields: [{ name: "content_vector", vectorSearchDimensions: 3 }] };

function resultsFor(documents: typeof original[]) {
  return { results: (async function* () { for (const document of documents) yield { document }; })() };
}
function report() {
  return JSON.parse(mocks.writeFile.mock.calls.at(-1)![1]);
}

describe("backfill command", () => {
  let previousExitCode: typeof process.exitCode;
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    previousExitCode = process.exitCode;
    process.exitCode = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.options = { settings: "test-settings.json", endpoint: "https://example.search.windows.net", index: "test-index",
      "source-id": "source'1", output: "backfill-test-report.json", apply: false };
    mocks.readFile.mockResolvedValue(JSON.stringify({ AZURE_OPENAI_CUSTOM_ENDPOINT: "https://example.openai.azure.com/openai/deployments", AZURE_OPENAI_API_KEY: "test-key" }));
    mocks.getIndex.mockResolvedValue(index);
    mocks.createOrUpdateIndex.mockImplementation(async updated => updated);
    mocks.search.mockResolvedValue(resultsFor([original]));
    mocks.getDocument.mockResolvedValue(original);
    mocks.embedQuery.mockResolvedValue([0.1, 0.2, 0.3]);
    mocks.mergeDocuments.mockResolvedValue({ results: [{ key: original.id, succeeded: true }] });
  });
  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  it("previews without updating the schema, requesting embeddings, or writing Search documents", async () => {
    await import("../scripts/backfill-evidence-dates.mjs");
    expect(report()).toMatchObject({ mode: "preview", planned: 1, embeddingRequired: 1,
      updated: 0, embedded: 0, errors: [] });
    expect(mocks.createOrUpdateIndex).not.toHaveBeenCalled();
    expect(mocks.embedQuery).not.toHaveBeenCalled();
    expect(mocks.mergeDocuments).not.toHaveBeenCalled();
    expect(mocks.search).toHaveBeenCalledWith("*", expect.objectContaining({
      filter: "sourceId eq 'source''1' and tags/any(t: t eq 'event' or t eq 'fact' or t eq 'claim')",
      select: ["id", "content", "metadata", "tags", "whenStarted", "whenEnded"],
    }));
  });

  it("checks per-document merge failures even when Search resolves the request", async () => {
    mocks.options.apply = true;
    mocks.mergeDocuments.mockResolvedValue({ results: [{ key: original.id, succeeded: false, errorMessage: "document not found" }] });
    await import("../scripts/backfill-evidence-dates.mjs");
    expect(process.exitCode).toBe(1);
    expect(report()).toMatchObject({ planned: 1, embedded: 1, updated: 0, errors: [{ id: original.id, message: "Search merge failed for original-id: document not found" }] });
  });

  it("skips completed entries and limits pending updates on a resumed apply", async () => {
    mocks.options.apply = true;
    mocks.options.limit = "1";
    const update = prepareEvidenceContentUpdate(original);
    if (update.status !== "update") throw new Error("Expected update");
    mocks.search.mockResolvedValue(resultsFor([{ ...update.document, id: "completed-id" }, original, { ...original, id: "next-id" }]));
    await import("../scripts/backfill-evidence-dates.mjs");
    expect(report()).toMatchObject({ current: 1, scanned: 2, planned: 1, updated: 1, embedded: 1, errors: [] });
    expect(mocks.embedQuery).toHaveBeenCalledExactlyOnceWith(update.document.content);
    expect(mocks.mergeDocuments).toHaveBeenCalledExactlyOnceWith([{ ...update.document, content_vector: [0.1, 0.2, 0.3] }]);
  });

  it("finishes Search paging before writing records that could reorder later pages", async () => {
    mocks.options.apply = true;
    const second = { ...original, id: "second-id" };
    let paging = true;
    mocks.search.mockResolvedValue({ results: (async function* () {
      yield { document: original };
      yield { document: second };
      paging = false;
    })() });
    mocks.getDocument.mockImplementation(async id => id === second.id ? second : original);
    mocks.mergeDocuments.mockImplementation(async ([document]) => {
      expect(paging).toBe(false);
      return { results: [{ key: document.id, succeeded: true }] };
    });
    await import("../scripts/backfill-evidence-dates.mjs");
    expect(report()).toMatchObject({ scanned: 2, planned: 2, updated: 2, embedded: 2, errors: [] });
    expect(mocks.mergeDocuments).toHaveBeenCalledTimes(2);
  });

  it("reports unsupported record IDs without reporting their content", async () => {
    mocks.search.mockResolvedValue(resultsFor([{ ...original, content: "A partial fragment" }]));
    await import("../scripts/backfill-evidence-dates.mjs");
    expect(report()).toMatchObject({ unsupported: 1, unsupportedIds: [original.id], planned: 0 });
    expect(mocks.writeFile.mock.calls.at(-1)![1]).not.toContain("A partial fragment");
  });
});
