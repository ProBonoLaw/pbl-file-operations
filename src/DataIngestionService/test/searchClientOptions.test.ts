import {createHttpHeaders} from "@azure/core-rest-pipeline";
import {AzureKeyCredential, SearchClient} from "@azure/search-documents";
import {describe, expect, it} from "vitest";
import {searchDocumentClientOptions} from "../src/processors/searchClientOptions.js";

describe("alias-compatible document requests", () => {
  it("sends the pinned API on hybrid searches, uploads and deletions without replacing the alias", async () => {
    const requests: {url: URL; body: any}[] = [];
    const client = new SearchClient<{id: string}>("https://example.search.windows.net", "account-alias", new AzureKeyCredential("test"), {
      ...searchDocumentClientOptions,
      httpClient: {sendRequest: async request => {
        const url = new URL(request.url), body = JSON.parse(request.body as string);
        requests.push({url, body});
        return {request, status: 200, headers: createHttpHeaders({"content-type": "application/json"}),
          bodyAsText: JSON.stringify({value: url.pathname.endsWith("/search.post.search")
            ? [{id: "one", "@search.score": 0.03, "@search.rerankerScore": 2.5}]
            : [{key: "one", status: true, statusCode: 200}]})};
      }},
    });
    const result = await client.search("source statement", {filter: "sourceId eq '6' and not tags/any()",
      queryType: "semantic", semanticSearchOptions: {configurationName: "Primary", errorMode: "fail"},
      vectorSearchOptions: {filterMode: "preFilter", queries: [{kind: "vector", vector: [1, 0], fields: ["content_vector"], kNearestNeighborsCount: 50}]}});
    const hits = []; for await (const hit of result.results) hits.push(hit);
    expect(hits).toEqual([expect.objectContaining({document: {id: "one"}, rerankerScore: 2.5})]);
    await client.uploadDocuments([{id: "one"}], {throwOnAnyFailure: true});
    await client.deleteDocuments([{id: "one"}], {throwOnAnyFailure: true});
    expect(requests).toHaveLength(3);
    for (const {url} of requests) {
      expect(url.searchParams.get("api-version")).toBe("2026-04-01");
      expect(decodeURIComponent(url.pathname)).toContain("account-alias");
    }
    expect(requests[0].body).toMatchObject({filter: "sourceId eq '6' and not tags/any()", queryType: "semantic",
      semanticConfiguration: "Primary", semanticErrorHandling: "fail", vectorFilterMode: "preFilter",
      vectorQueries: [{kind: "vector", vector: [1, 0], fields: "content_vector", k: 50}]});
    expect(requests[1].body.value).toEqual([{id: "one", "@search.action": "upload"}]);
    expect(requests[2].body.value).toEqual([{id: "one", "@search.action": "delete"}]);
  });
});
