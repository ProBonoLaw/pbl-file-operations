/** Shared label comparisons; retained source labels keep their original spelling. */
export const metadataText = (value: unknown): string => typeof value === "string"
  ? value.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
export const identityText = (value: unknown): string => metadataText(value)
  .replace(/[‘’]/g, "'").toLowerCase();
export const knownMetadataText = (value: unknown): string | null => {
  const label = metadataText(value);
  return label && !/^(unknown|null|n\/a|not applicable)$/iu.test(label) ? label : null;
};
/** Raw strings are for tags and provenance, which must not lose labels. */
export const metadataStrings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string") : [];
export const unionMetadataStrings = (...values: unknown[]): string[] =>
  [...new Set(values.flatMap(metadataStrings))];
/** Participant comparisons consistently treat unknown annotations as absent. */
export const knownIdentityLabels = (value: unknown): string[] =>
  [...new Set(metadataStrings(value).filter(knownMetadataText).map(identityText))].sort();
export const evidenceKind = (metadata: Record<string, unknown>): "event" | "fact" | "claim" =>
  metadata.claimType ? "claim" : metadata.factType ? "fact" : "event";
