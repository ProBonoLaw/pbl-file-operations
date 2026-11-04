import type { SearchField } from "@azure/search-documents";

export function extractionSearchFields(): SearchField[] {
  return [
    ...["sourceType", "contentOrigin", "extractionProvider", "analysisId", "evidenceExtractionMode"].map(name => ({
      name, type: "Edm.String" as const, filterable: true,
    })),
    ...["startTimeMs", "endTimeMs"].map(name => ({ name, type: "Edm.Int64" as const, filterable: true, sortable: true })),
  ];
}
