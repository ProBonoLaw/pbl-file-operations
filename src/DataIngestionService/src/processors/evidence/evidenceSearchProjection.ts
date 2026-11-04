import type { SearchField } from "@azure/search-documents";

/** Fields used for evidence-specific filtering alongside hybrid content retrieval. */
export function evidenceRetrievalFields(): SearchField[] {
  return [
    ...["evidenceKind", "eventType", "factType", "claimType", "claimPolarity", "claimant"].map(name => ({
      name, type: "Edm.String" as const, filterable: true, facetable: true,
      ...(name === "claimant" ? { searchable: true } : {}),
    })),
    ...["subject", "reportedBy"].map(name => ({
      name, type: "Collection(Edm.String)" as const, searchable: true, filterable: true, facetable: true,
    })),
    { name: "sourceContentHash", type: "Edm.String", filterable: true },
  ];
}

/** Preserve kind-specific attribution; inherited user tags cannot turn chunks into evidence. */
export function evidenceSearchValues(metadata: Record<string, unknown>) {
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
  const names = (value: unknown) => Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string" && !!name.trim()) : [];
  const tags = names(metadata.tags);
  const hasCitations = Array.isArray(metadata.sourceSpans) && metadata.sourceSpans.length > 0;
  const kind = !hasCitations ? null : text(metadata.claimType) ? "claim"
    : text(metadata.factType) ? "fact" : tags.includes("event") ? "event" : null;
  return {
    evidenceKind: kind,
    eventType: kind === "event" ? text(metadata.eventType)
      ?? text(tags.find(tag => tag.startsWith("eventType:"))?.slice("eventType:".length)) : null,
    factType: kind === "fact" ? text(metadata.factType) : null,
    claimType: kind === "claim" ? text(metadata.claimType) : null,
    claimPolarity: kind === "claim" ? text(metadata.claimPolarity) : null,
    claimant: kind === "claim" ? text(metadata.claimant) : null,
    subject: kind === "fact" ? names(metadata.subject) : [],
    reportedBy: kind === "fact" ? names(metadata.reportedBy) : [],
    sourceContentHash: kind ? text(metadata.sourceContentHash) : null,
  };
}
