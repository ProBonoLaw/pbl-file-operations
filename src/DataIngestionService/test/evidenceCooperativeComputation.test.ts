import {Document} from "@langchain/core/documents";
import {afterEach, describe, expect, it, vi} from "vitest";
import {findDocumentDuplicateCandidates, findDocumentDuplicateCandidatesAsync} from "../src/processors/evidence/evidenceDocumentDeduplication.js";
import {findCanonicalizationPairs, findCanonicalizationPairsAsync, applyCanonicalizationDecisions, applyCanonicalizationDecisionsAsync,
  canonicalizationReviewBatches, canonicalizationReviewBatchesAsync} from "../src/processors/evidence/evidenceCanonicalization.js";
import {withEvidenceTaskCancellation} from "../src/processors/evidence/evidenceAsync.js";
import {EvidenceSource} from "../src/processors/evidence/evidenceSource.js";

afterEach(()=>vi.restoreAllMocks());
function fixture() {
  const quote="Casey completed the assessment.";
  const source=new EvidenceSource(new Document({pageContent:`${quote} ${quote}`,metadata:{pages:[1]}}));
  const documents=Array.from({length:24},(_,i)=>new Document({pageContent:"",metadata:{accountId:"account",sourceId:"source",
    sourceContentHash:source.contentHash,what:quote,who:["Casey"],subject:["Casey"],tags:["fact"],factType:"attribute",
    pages:[1],sourceOffset:i%2 ? 0 : quote.length+1,sourceQuote:quote,
    sourceSpans:[{pageNumber:1,sourceOffset:i%2 ? 0 : quote.length+1,sourceQuote:quote}],extractedBy:["reviewer-"+i]}}));
  const vectors=documents.map((_,i)=>i===2 ? null : Array.from({length:64},(_,j)=>j===0 ? 1 : i%3/100));
  return {documents,source,options:{vectors,source,embeddingTopK:3,searchPairs:[{leftIndex:21,rightIndex:0}]}};
}

describe("cooperative document computation",()=>{
  it("services event-loop callbacks during planning and merge application without changing candidates, order or guards",async()=>{
    const {documents,source,options}=fixture();
    const expectedCandidates=findDocumentDuplicateCandidates(documents,options);
    const expectedPairs=findCanonicalizationPairs(documents,options);
    // Deterministic slice expiration avoids wall-clock speed assertions.
    let elapsed=0;
    vi.spyOn(performance,"now").mockImplementation(()=>elapsed+=25);
    let beats=0;
    let timer:ReturnType<typeof setImmediate>;
    const heartbeat=()=>{beats++;timer=setImmediate(heartbeat);};
    timer=setImmediate(heartbeat);
    try {
      expect(await findDocumentDuplicateCandidatesAsync(documents,options)).toEqual(expectedCandidates);
      const afterRetrieval=beats;
      expect(afterRetrieval).toBeGreaterThan(2);
      const pairs=await findCanonicalizationPairsAsync(documents,options);
      expect(pairs).toEqual(expectedPairs);
      expect(beats).toBeGreaterThan(afterRetrieval);
      expect(pairs.some(pair=>pair.leftIndex>pair.rightIndex)).toBe(true);
      for (const grouped of [false, true]) {
        const beforeBatching=beats;
        expect(await canonicalizationReviewBatchesAsync(pairs,grouped)).toEqual(canonicalizationReviewBatches(pairs,grouped));
        expect(beats).toBeGreaterThan(beforeBatching);
      }
      const decisions=pairs.map(pair=>({pairId:pair.id,survivor:pair.allowedSurvivors[0],
        leftOnlyDetails:[],rightOnlyDetails:[],reason:"The same cited assessment."}));
      const beforeMerging=beats;
      expect(await applyCanonicalizationDecisionsAsync(documents,pairs,decisions,source))
        .toEqual(applyCanonicalizationDecisions(documents,pairs,decisions,source));
      expect(beats).toBeGreaterThan(beforeMerging);
    } finally {clearImmediate(timer!);}
  });

  it.each(["planning", "batching"])("stops %s promptly when the job is cancelled between slices",async phase=>{
    const {documents,options}=fixture();
    const pairs=findCanonicalizationPairs(documents,options);
    let elapsed=0;
    vi.spyOn(performance,"now").mockImplementation(()=>elapsed+=25);
    const controller=new AbortController(), failure=new Error("job stopped");
    const timer=setImmediate(()=>controller.abort(failure));
    try {
      await expect(withEvidenceTaskCancellation({signal:controller.signal,assertOpen:async()=>controller.signal.throwIfAborted()},
        ()=>phase==="planning" ? findCanonicalizationPairsAsync(documents,options)
          : canonicalizationReviewBatchesAsync(pairs,true))).rejects.toBe(failure);
    } finally {clearImmediate(timer);}
  });
});
