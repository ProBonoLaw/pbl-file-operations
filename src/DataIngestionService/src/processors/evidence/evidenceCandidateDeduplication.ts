/** Stable object keys without changing text, array order, or evidence fields. */
export function stableEvidenceJson(value: unknown): string {
  return JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
    ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
}

/** Only identical, uniquely cited candidates share a review. Paraphrases and
 * differing dates, speakers, qualifiers, or citations remain separate. */
export function deduplicateEvidenceCandidates<T extends {
  kind: string; item: unknown; extractedBy: string[]; feedback?: string;
}>(candidates: readonly T[], citationsValid: (candidate: T) => boolean): T[] {
  const result: T[] = [];
  const positions = new Map<string, number>();
  for (const candidate of candidates) {
    if (!citationsValid(candidate)) { result.push(candidate); continue; }
    const key = stableEvidenceJson([candidate.kind, candidate.item, candidate.feedback]);
    const index = positions.get(key);
    if (index === undefined) {
      positions.set(key, result.length);
      result.push({...candidate, extractedBy:[...candidate.extractedBy]});
    } else {
      result[index] = {...result[index], extractedBy:[...new Set([...result[index].extractedBy, ...candidate.extractedBy])]};
    }
  }
  return result;
}
