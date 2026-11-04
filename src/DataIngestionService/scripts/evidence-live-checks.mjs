import { evidenceKind, identityText, knownIdentityLabels } from "../dist/src/processors/evidence/evidenceMetadataValues.js";

/** A repeat must have the same representation, attribution and cited occurrence. */
export function repeatedExactAssertionGroups(documents) {
  const groups = new Map();
  for (const {metadata: m} of documents) {
    const span = m.sourceSpans?.[0];
    const key = JSON.stringify([m.accountId, m.sourceId, m.sourceContentHash,
      evidenceKind(m), m.claimType, m.factType, m.eventType,
      identityText(m.claimant), m.claimPolarity, knownIdentityLabels(m.who),
      knownIdentityLabels(m.subject), knownIdentityLabels(m.reportedBy),
      m.whenStarted, m.whenEnded, m.asOf, m.eventDateResolution,
      span?.pageNumber, span?.sourceOffset, span?.sourceQuote, identityText(m.what)]);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.values()].filter(count => count > 1).length;
}

export function extractionSkippedOnReplay(candidateMode, events) {
  return candidateMode !== "replay" || !events.some(event =>
    event.name === "llm.call.token_usage"
      && (event.properties.stage?.startsWith("primary-") || event.properties.stage === "independent"));
}

/** Merged records retain tags from every classification; validate their primary
 * representation using structured fields rather than counting overlapping tags.
 */
export function partitionEvidenceDocuments(documents) {
  const groups = { events: [], facts: [], claims: [] };
  for (const document of documents) {
    const metadata = document.metadata;
    if (metadata.claimType) groups.claims.push(document);
    else if (metadata.factType) groups.facts.push(document);
    else if (metadata.tags?.includes("event")) groups.events.push(document);
    else throw new Error("Unrecognized evidence representation in live result");
  }
  return groups;
}
