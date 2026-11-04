import type { ConsistencyRecord } from "./evidenceConsistency.js";
import { normalizeAssertionPair, type AssertionNormalization } from "./evidenceAssertionNormalization.js";

export const ASSERTION_ALIGNMENT_VERSION = "3";
export interface AssertionAlignment {
  version:string;
  status:"likely-aligned"|"uncertain"|"related-only";
  reasons:string[];
  sharedTerms:string[];
  leftOnlyTerms:string[];
  rightOnlyTerms:string[];
  leftCoverage:number;
  rightCoverage:number;
  orderedCoverage:number;
  normalizations:AssertionNormalization[];
}

const normal = (value:string) => value.normalize("NFKC").toLowerCase().replace(/[’‘]/g,"'")
  .replace(/\bcan't\b/g,"can not").replace(/\bcannot\b/g,"can not").replace(/n't\b/g," not")
  .replace(/'s\b/g,"").replace(/\s+/g," ").trim();
const tokens = (value:string) => normal(value).match(/[\p{L}\p{N}]+/gu)??[];
// Only grammatical variants, never domain synonyms or taxonomy labels.
const forms:Record<string,string> = {indicating:"indicate",indicates:"indicate",indicated:"indicate",
  seemed:"seem",seems:"seem",appeared:"appear",appears:"appear",reported:"report",reports:"report",
  recommended:"recommend",recommends:"recommend",stated:"state",states:"state",
  denies:"deny",denied:"deny",suggested:"suggest",suggests:"suggest",suggesting:"suggest"};
const stop = new Set("a an the is are was were be been being has have had do does did of to in on at for with by from and or that this these those his her their its he she it as during".split(" "));
const unique = (values:string[]) => [...new Set(values)];
const equal = (a:string[],b:string[]) => JSON.stringify(a)===JSON.stringify(b);
const markerSet = (words:string[],expression:RegExp) => unique(words.filter(word=>expression.test(word))).sort();

/** Linear memory, bounded input. This is word-order evidence, not a semantic parser. */
function orderedOverlap(a:string[],b:string[]):number {
  let previous=new Array<number>(b.length+1).fill(0);
  for(const word of a){
    const next=new Array<number>(b.length+1).fill(0);
    for(let j=0;j<b.length;j++)next[j+1]=word===b[j] ? previous[j]+1 : Math.max(previous[j+1],next[j]);
    previous=next;
  }
  return previous[b.length]/Math.max(1,a.length,b.length);
}

/**
 * Conservative review routing from statement wording. No label, facet, vector
 * score or reference adjudication is used as evidence of assertion equivalence.
 * A likely match still requires source review and never authorizes a merge.
 */
export function assessAssertionAlignment(left:ConsistencyRecord,right:ConsistencyRecord):AssertionAlignment {
  const normalized=normalizeAssertionPair(left,right);
  const rawLeft=tokens(normalized.leftStatement),rawRight=tokens(normalized.rightStatement);
  const namedTerms=new Set([...left.fields.people,...right.fields.people,left.fields.claimant,right.fields.claimant]
    .filter(value=>! /^(unknown.*|n\/a|null)$/i.test(value.trim())).flatMap(tokens).filter(word=>!stop.has(word)));
  const content=(words:string[])=>words.filter(word=>!stop.has(word)&&!namedTerms.has(word)).map(word=>forms[word]??word);
  const a=content(rawLeft),b=content(rawRight),leftTerms=unique(a),rightTerms=unique(b);
  const shared=leftTerms.filter(word=>rightTerms.includes(word));
  const leftOnly=leftTerms.filter(word=>!rightTerms.includes(word)),rightOnly=rightTerms.filter(word=>!leftTerms.includes(word));
  const leftCoverage=shared.length/Math.max(1,leftTerms.length),rightCoverage=shared.length/Math.max(1,rightTerms.length);
  const bounded=a.length<=160 && b.length<=160;
  const orderedCoverage=bounded ? orderedOverlap(a,b) : 0;
  const result=(status:AssertionAlignment["status"],...reasons:string[]):AssertionAlignment=>({version:ASSERTION_ALIGNMENT_VERSION,
    status,reasons,sharedTerms:shared,leftOnlyTerms:leftOnly,rightOnlyTerms:rightOnly,leftCoverage,rightCoverage,orderedCoverage,
    normalizations:normalized.applied});
  // Even an exact quote cannot identify which of its clauses a record asserts.
  if(!bounded)return result("uncertain","statement-too-long-for-alignment");
  const qualifiers=/^(no|not|never|without|neither|nor|may|might|could|can|will|would|shall|possible|possibly|likely|unlikely|alleged|allegedly|suspected|should|must|seem|appear|recommend|deny|suggest)$/;
  const normalizedLeft=rawLeft.map(word=>forms[word]??word),normalizedRight=rawRight.map(word=>forms[word]??word);
  const guards:string[]=[...normalized.guards];
  if(!equal(markerSet(normalizedLeft,qualifiers),markerSet(normalizedRight,qualifiers)))guards.push("qualification-or-negation-differs");
  const relations=/^(by|from|to|before|after|under|over|above|below|between|within|versus|than|less|more|least|most|greater|fewer|only|all|some|each)$/;
  const relationMarkers=(words:string[])=>normalized.applied.length ? words.filter(word=>relations.test(word)) : markerSet(words,relations);
  if(!equal(relationMarkers(rawLeft),relationMarkers(rawRight)))guards.push("relation-or-quantifier-differs");
  const operators=(record:ConsistencyRecord)=>unique(record.statement.match(/[<>=≤≥]+/g)??[]).sort();
  if(!equal(operators(left),operators(right)))guards.push("comparison-operators-differ");
  // Compare numeric text intact, so 1.5 cannot be confused with 15 or 5.1.
  const numbers=(statement:string)=>unique(normal(statement).match(/\b\d+(?:[.,:/-]\d+)*\b/g)??[]).sort();
  if(!equal(numbers(normalized.leftStatement),numbers(normalized.rightStatement)))guards.push("numbers-differ");
  const mentionLeft=rawLeft.filter(word=>namedTerms.has(word)),mentionRight=rawRight.filter(word=>namedTerms.has(word));
  const sharedNames=new Set(mentionLeft.filter(word=>mentionRight.includes(word)));
  if(!equal(mentionLeft.filter(word=>sharedNames.has(word)),mentionRight.filter(word=>sharedNames.has(word))))guards.push("participant-order-or-repetition-differs");
  // Missing/expanded names are ambiguous; never resolve aliases by first name.
  if(mentionLeft.some(word=>!sharedNames.has(word)) && mentionRight.some(word=>!sharedNames.has(word)))guards.push("named-participants-differ");
  const reporting=/^(say|said|state|report|write|wrote|communicate|communicated)$/;
  if(Boolean(normalizedLeft.some(word=>reporting.test(word)))!==Boolean(normalizedRight.some(word=>reporting.test(word))))guards.push("reporting-act-versus-content");
  if(normal(left.statement)===normal(right.statement))return result("likely-aligned","same-statement-wording");
  if(!leftTerms.length || !rightTerms.length)return result("uncertain","insufficient-assertion-terms",...guards);
  if(Math.min(leftCoverage,rightCoverage)<0.45 && leftOnly.length && rightOnly.length)
    return result("related-only","different-assertion-terms",...guards);
  if(guards.length)return result("uncertain",...guards);
  // A single replacement (walking/talking, above/below) can change the assertion
  // inside an otherwise identical template. Do not vote it away with a ratio.
  if(leftOnly.length || rightOnly.length)
    return result("uncertain",leftOnly.length && rightOnly.length ? "unmatched-assertion-terms" : "partial-or-compound-assertion");
  if(shared.length>=2 && orderedCoverage===1)
    return result("likely-aligned","matching-assertion-terms-and-order");
  return result("uncertain","insufficient-terms-or-different-word-order");
}
