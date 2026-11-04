import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicateDocumentProcessor } from "../src/processors/duplicateDocumentProcessor.ts";

const azure = vi.hoisted(() => ({
  cosmosOptions: [] as unknown[],
  databaseNames: [] as string[],
  containerNames: [] as string[],
  searchClients: [] as Array<{ endpoint: string; indexName: string; options: unknown }>,
  searchIndexClients: [] as string[],
  query: vi.fn(),
  fetchAll: vi.fn(),
  dispose: vi.fn(),
  search: vi.fn(),
  deleteDocuments: vi.fn(),
  deleteIndex: vi.fn(),
}));

vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    constructor(options: unknown) {
      azure.cosmosOptions.push(options);
    }

    database(name: string) {
      azure.databaseNames.push(name);
      return {
        container(name: string) {
          azure.containerNames.push(name);
          return { items: { query: azure.query } };
        },
      };
    }

    dispose() {
      azure.dispose();
    }
  },
}));

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {},
}));

vi.mock("@azure/search-documents", () => ({
  SearchClient: class {
    constructor(endpoint: string, indexName: string, _credential: unknown, options: unknown) {
      azure.searchClients.push({ endpoint, indexName, options });
    }

    search(query: string, options: unknown) {
      return azure.search(query, options);
    }

    deleteDocuments(ids: Array<{ id: string }>, options: unknown) {
      return azure.deleteDocuments(ids, options);
    }
  },
  SearchIndexClient: class {
    constructor(endpoint: string) {
      azure.searchIndexClients.push(endpoint);
    }

    deleteIndex(indexName: string) {
      return azure.deleteIndex(indexName);
    }
  },
}));

function searchPages(...pages: Array<Array<{ id?: string }>>) {
  return {
    results: {
      async *byPage() {
        for (const documents of pages) {
          yield { results: documents.map((document) => ({ document })) };
        }
      },
    },
  };
}

function processor() {
  return new DuplicateDocumentProcessor(
    "account-123",
    "https://cosmos.test",
    "conversation-db",
    "accounts",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  azure.cosmosOptions.length = 0;
  azure.databaseNames.length = 0;
  azure.containerNames.length = 0;
  azure.searchClients.length = 0;
  azure.searchIndexClients.length = 0;
  azure.query.mockReturnValue({ fetchAll: azure.fetchAll });
  azure.fetchAll.mockResolvedValue({
    resources: [{ dataSourceId: "general-index", searchEndpoint: "https://search.test" }],
  });
  azure.search.mockResolvedValue(searchPages([]));
  azure.deleteDocuments.mockResolvedValue({});
  azure.deleteIndex.mockResolvedValue({});
});

afterEach(() => vi.restoreAllMocks());

describe("DuplicateDocumentProcessor", () => {
  it("loads account index details from the account partition and disposes Cosmos", async () => {
    const subject = processor();

    await subject.open();

    expect(azure.cosmosOptions).toEqual([
      expect.objectContaining({ endpoint: "https://cosmos.test" }),
    ]);
    expect(azure.databaseNames).toEqual(["conversation-db"]);
    expect(azure.containerNames).toEqual(["accounts"]);
    expect(azure.query).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.stringContaining("ACCOUNT_DETAILS") }),
      { partitionKey: ["account-123"] },
    );
    expect(azure.searchClients).toEqual([
      { endpoint: "https://search.test", indexName: "general-index", options: { serviceVersion: "2026-04-01" } },
    ]);
    expect(azure.dispose).toHaveBeenCalledOnce();
  });

  it("reports missing account details and still disposes Cosmos", async () => {
    azure.fetchAll.mockResolvedValue({ resources: [] });

    await expect(processor().open()).rejects.toThrow(
      "Missing account details for account account-123",
    );

    expect(azure.dispose).toHaveBeenCalledOnce();
    expect(azure.searchClients).toEqual([]);
  });

  it("removes matching documents across search result pages", async () => {
    const subject = processor();
    await subject.open();
    azure.search.mockResolvedValue(
      searchPages([{ id: "doc-a" }, {}], [{ id: "doc-b" }]),
    );

    const removed = await subject.removeEntries("source-456");

    expect(removed).toBe(true);
    expect(azure.search).toHaveBeenCalledWith("*", {
      filter: "sourceId eq 'source-456'",
    });
    expect(azure.deleteDocuments).toHaveBeenCalledExactlyOnceWith([
      { id: "doc-a" },
      { id: "doc-b" },
    ], { throwOnAnyFailure: true });
  });

  it("returns false when no matching documents exist", async () => {
    const subject = processor();
    await subject.open();

    await expect(subject.removeEntries("source-456")).resolves.toBe(false);

    expect(azure.deleteDocuments).not.toHaveBeenCalled();
  });

  it("propagates search failures instead of treating them as no matches", async () => {
    const subject = processor();
    await subject.open();
    azure.search.mockRejectedValueOnce(new Error("search unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(subject.removeEntries("source-456"))
      .rejects.toThrow("search unavailable");

    expect(azure.deleteDocuments).not.toHaveBeenCalled();
  });

  it("stops on a failed deletion batch and propagates the error", async () => {
    const subject = processor();
    await subject.open();
    const documents = Array.from({ length: 10_001 }, (_, i) => ({ id: `doc-${i}` }));
    azure.search.mockResolvedValue(searchPages(documents));
    azure.deleteDocuments.mockRejectedValueOnce(new Error("search unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(subject.removeEntries("source-456"))
      .rejects.toThrow("search unavailable");

    expect(azure.deleteDocuments).toHaveBeenCalledOnce();
    expect(azure.deleteDocuments.mock.calls[0][0]).toHaveLength(10_000);
    expect(azure.deleteDocuments.mock.calls[0][1]).toEqual({ throwOnAnyFailure: true });
  });

  it("deletes the resolved index for an account purge", async () => {
    const subject = processor();
    await subject.open();

    await subject.delete();

    expect(azure.searchIndexClients).toEqual(["https://search.test"]);
    expect(azure.deleteIndex).toHaveBeenCalledExactlyOnceWith("general-index");
  });

  it("propagates a rejected account index deletion", async () => {
    const subject = processor();
    await subject.open();
    azure.deleteIndex.mockRejectedValueOnce(new Error("index deletion rejected"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(subject.delete()).rejects.toThrow("index deletion rejected");

    expect(azure.deleteIndex).toHaveBeenCalledExactlyOnceWith("general-index");
  });
});
