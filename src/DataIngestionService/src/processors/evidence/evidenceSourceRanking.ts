import type {EvidenceSource, SourceSpan} from "./evidenceSource.js";
import type {SourcePartitionHit} from "./sourcePartitionSearch.js";

export type SourceLookupCitation = Pick<SourceSpan, "pageNumber" | "sourceQuote"> & Partial<Pick<SourceSpan, "sourceOffset">>;

export function sourceRerankerCutoff(value = process.env.EVIDENCE_SOURCE_MIN_RERANKER_SCORE): number | null {
  const setting = value?.trim();
  if (!setting || setting === "off") return null;
  const score = Number(setting);
  if (!Number.isFinite(score) || score < 0 || score > 4)
    throw new Error("EVIDENCE_SOURCE_MIN_RERANKER_SCORE must be off or a number from 0 to 4");
  return score;
}

/** Bind existing evidence citations before prompt compaction. Retrieved or
 * generated context cannot supply its own protection exceptions.
 */
export function sourceLookupCitations(content: string): SourceLookupCitation[] {
  let input: unknown;
  try {input = JSON.parse(content);} catch {return [];}
  const citations: SourceLookupCitation[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {value.forEach(visit); return;}
    const row = value as Record<string, unknown>;
    if (Number.isSafeInteger(row.pageNumber) && typeof row.sourceQuote === "string" && row.sourceQuote.trim()
      && (row.sourceOffset === undefined || Number.isSafeInteger(row.sourceOffset)))
      citations.push({pageNumber: row.pageNumber as number, sourceQuote: row.sourceQuote,
        ...(row.sourceOffset === undefined ? {} : {sourceOffset: row.sourceOffset as number})});
    for (const [key, child] of Object.entries(row))
      if (key !== "retrievedContext" && key !== "unverifiedContext") visit(child);
  };
  visit(input);
  return citations;
}

/** Literal source spans an extracted partition can supply as citable passages.
 * Chunk boundaries and Markdown structure are lossy. Match complete blocks to
 * literal text; never manufacture offsets from pos or chunk lengths.
 */
export function locateSourcePartition(source: EvidenceSource, hit: SourcePartitionHit): SourceSpan[] {
  const located: SourceSpan[] = [];
  if (hit.contentOrigin !== "extracted") return located;
  for (const page of hit.pages ?? []) {
    for (const block of hit.content.split(/<!-- PageBreak -->|\n\s*\n/).filter(block => block.trim())) {
      for (const match of source.matchOnPage(page, block)) {
        for (let offset = 0; offset < match.sourceQuote.length; offset += 900) located.push({pageNumber: page,
          sourceOffset: match.sourceOffset + offset, sourceQuote: match.sourceQuote.slice(offset, offset + 1100)});
      }
    }
  }
  return located;
}

/** Recompute eligibility per request while retaining the raw scored query cache.
 * A low-score hit is protected only if it supplies the cited occurrence itself,
 * not merely the same quotation text elsewhere on the page.
 */
export function selectSourcePartitionHits(source: EvidenceSource, hits: SourcePartitionHit[], cutoff: number | null,
  citations: readonly SourceLookupCitation[] = []): {hits: SourcePartitionHit[]; protectedHits: number} {
  if (cutoff === null) return {hits, protectedHits: 0};
  const anchors = citations.flatMap(citation => citation.sourceQuote.trim() ? source.matchOnPage(citation.pageNumber, citation.sourceQuote)
    .filter(match => citation.sourceOffset === undefined || match.sourceOffset === citation.sourceOffset) : []);
  let protectedHits = 0;
  const selected = hits.filter(hit => {
    if (hit.rerankerScore === undefined || hit.rerankerScore >= cutoff) return true;
    const protectedCitation = anchors.length > 0 && locateSourcePartition(source, hit).some(span => anchors.some(anchor =>
      span.pageNumber === anchor.pageNumber && span.sourceOffset <= anchor.sourceOffset
        && anchor.sourceOffset + anchor.sourceQuote.length <= span.sourceOffset + span.sourceQuote.length));
    if (protectedCitation) protectedHits++;
    return protectedCitation;
  });
  return {hits: selected, protectedHits};
}
