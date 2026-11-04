import type { SearchField, SearchIndex, SearchIndexClient } from "@azure/search-documents";
import { extractionSearchFields } from "../extractionSearchSchema.js";
import { evidenceRetrievalFields } from "./evidenceSearchProjection.js";

export function asOfSearchField(): SearchField {
  return {
    name: "asOf", type: "Edm.ComplexType",
    fields: ["year", "month", "day", "season", "quarter"].map(name => ({
      name, type: "Edm.String", searchable: true, filterable: true, facetable: true,
      ...(["year", "month", "day"].includes(name) ? { sortable: true } : {}),
    })),
  };
}

/** Add evidence fields without replacing an account's other fields or search settings. */
export async function ensureEvidenceSearchFields(
  client: Pick<SearchIndexClient, "getIndex" | "createOrUpdateIndex">,
  indexName: string,
): Promise<SearchIndex> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const index = await client.getIndex(indexName);
    const fields = [...index.fields];
    let changed = false;
    for (const field of [...extractionSearchFields(), ...evidenceRetrievalFields()]) {
      const existing = fields.find(candidate => candidate.name === field.name);
      if (!existing) { fields.push(field); changed = true; }
      else if (existing.type !== field.type || !("filterable" in existing) || !existing.filterable
        || ("searchable" in field && field.searchable && (!("searchable" in existing) || !existing.searchable))
        || ("facetable" in field && field.facetable && (!("facetable" in existing) || !existing.facetable)))
        throw new Error(`Search field ${field.name} has incompatible evidence retrieval or extraction provenance settings`);
    }
    const expected = asOfSearchField();
    const position = fields.findIndex(field => field.name === "asOf");
    if (position < 0) {
      fields.push(expected);
    } else {
      const existing = fields[position];
      if (existing.type !== "Edm.ComplexType" || expected.type !== "Edm.ComplexType") {
        throw new Error("Search field asOf must be an Edm.ComplexType");
      }
      const missing: SearchField[] = [];
      for (const required of expected.fields ?? []) {
        const found = existing.fields?.find(field => field.name === required.name);
        if (!found) missing.push(required);
        else if (found.type !== "Edm.String" || !found.filterable || !found.searchable) {
          throw new Error(`Search field asOf/${required.name} must be a searchable, filterable Edm.String`);
        }
      }
      if (!missing.length && !changed) return index;
      fields[position] = { ...existing, fields: [...(existing.fields ?? []), ...missing] };
    }
    try {
      return await client.createOrUpdateIndex({ ...index, fields }, { onlyIfUnchanged: true });
    } catch (error) {
      const status = (error as { statusCode?: number })?.statusCode;
      if (attempt === 2 || (status !== 409 && status !== 412)) throw error;
      // Another source may have updated this shared index; re-read its ETag.
    }
  }
  throw new Error("Could not update evidence search fields");
}
