import type { ConsistencyRecord } from "./evidenceConsistency.js";
import type { SourceSpan } from "./evidenceSource.js";
import { normalizeExaminerContext } from "./evidenceExaminerContext.js";

export interface AssertionNormalization {
  ruleId:"cited-score-percentile"|"anchored-causal-phrase"|"anchored-parent-help"|"cited-examiner-context";
  evidence:SourceSpan[];
}
const text=(value:string)=>value.normalize("NFKC").replace(/[’‘]/g,"'").replace(/\s+/g," ").trim().toLowerCase();
const sameSpan=(a:SourceSpan,b:SourceSpan)=>a.pageNumber===b.pageNumber && a.sourceOffset===b.sourceOffset && a.sourceQuote===b.sourceQuote;
const cells=(quote:string)=>quote.trim().startsWith("|") && quote.trim().endsWith("|") && !/[\r\n]/.test(quote)
  ? quote.trim().slice(1,-1).split("|").map(text) : [];
const ordinal=(value:number)=>value%100>=11&&value%100<=13 ? "th" : ({1:"st",2:"nd",3:"rd"}[value%10]??"th");

function assessmentStatement(statement:string) {
  const match=text(statement).match(/^(.+?) (?:score (?:was )?|result was score )(\d+(?:\.\d+)?), (?:at the (\d+)(st|nd|rd|th) percentile|percentile (\d+))\.?$/);
  if(!match)return null;
  const percentile=match[3]??match[5];
  if(Number(percentile)>100 || (match[4] && match[4]!==ordinal(Number(percentile))))return null;
  return {prefix:match[1],score:match[2],percentile};
}

/** Pair-specific, source-anchored wording transforms for review routing only.
 * The caller supplies source-validated records. Neither record is modified.
 */
export function normalizeAssertionPair(left:ConsistencyRecord,right:ConsistencyRecord) {
  let leftStatement=left.statement,rightStatement=right.statement;
  const applied:AssertionNormalization[]=[];
  const guards:string[]=[];
  const primary=left.sourceSpans[0],other=right.sourceSpans[0];
  if(!primary || !other || !left.sourceId || !left.sourceContentHash || left.sourceId!==right.sourceId
    || left.sourceContentHash!==right.sourceContentHash || left.documentGroup!==right.documentGroup || !sameSpan(primary,other))
    return {leftStatement,rightStatement,applied,guards};

  const examinerContext=normalizeExaminerContext(left,right);
  if(examinerContext){
    leftStatement=examinerContext.leftStatement;rightStatement=examinerContext.rightStatement;
    applied.push({ruleId:"cited-examiner-context",evidence:examinerContext.evidence});
  }

  // Do not infer column meaning from the numbers alone. Both records must cite
  // the same preceding header and row, with explicit score/percentile columns.
  const row=cells(primary.sourceQuote);
  const header=left.sourceSpans.find(span=>span.pageNumber===primary.pageNumber && span.sourceOffset<primary.sourceOffset
    && right.sourceSpans.some(other=>sameSpan(span,other))
    && /^(subtest|subscale|measure)$/.test(cells(span.sourceQuote)[0]??"")
    && JSON.stringify(cells(span.sourceQuote).slice(1))===JSON.stringify(["score","percentile"]));
  const a=assessmentStatement(leftStatement),b=assessmentStatement(rightStatement);
  if(row.length===3 && header && a && b && a.prefix===b.prefix && a.prefix.endsWith(` ${row[0]}`)
    && a.score===b.score && a.percentile===b.percentile && row[1]===a.score && row[2]===a.percentile
    && text(leftStatement)!==text(rightStatement)){
    leftStatement=rightStatement=`${a.prefix} score ${a.score} percentile ${a.percentile}`;
    applied.push({ruleId:"cited-score-percentile",evidence:[primary,header]});
  }

  // Restrict causal rewriting to an explicit passive action. In particular,
  // "payment due to X" is not interchangeable with "payment because of X".
  const causal=/\b(was|were|is|are) (raised|delayed|cancelled|canceled|postponed) (because of|due to)\b/g;
  const sourceActions=new Set([...text(primary.sourceQuote).matchAll(causal)].map(match=>match[2]));
  const leftCauses=[...text(leftStatement).matchAll(causal)],rightCauses=[...text(rightStatement).matchAll(causal)];
  const pairedActions=new Set(leftCauses.filter(a=>sourceActions.has(a[2]) && rightCauses.some(b=>a[2]===b[2]&&a[3]!==b[3])).map(match=>match[2]));
  const rewriteCause=(statement:string)=>text(statement).replace(causal,(whole,aux:string,action:string)=>
    pairedActions.has(action) ? `${aux} ${action} due to` : whole);
  const causalLeft=rewriteCause(leftStatement),causalRight=rewriteCause(rightStatement);
  if(causalLeft!==text(leftStatement) || causalRight!==text(rightStatement)){
    leftStatement=causalLeft;rightStatement=causalRight;
    applied.push({ruleId:"anchored-causal-phrase",evidence:[primary]});
  }

  // Keep the direction of help. This never rewrites "help to ... parents".
  // Different possessors remain ambiguous, even when a broad quote mentions both.
  const parentPhrase=/\b(?:parental help|parent help|help from (?:his|her|their) parents)\b/g;
  const possessors=new Set([leftStatement,rightStatement,primary.sourceQuote].flatMap(statement=>
    [...text(statement).matchAll(/\bhelp from (his|her|their) parents\b/g)].map(match=>match[1])));
  if(possessors.size>1)guards.push("parent-help-possessors-differ");
  if(possessors.size<=1 && [...text(primary.sourceQuote).matchAll(parentPhrase)].length){
    const rewriteParent=(statement:string)=>text(statement).replace(parentPhrase,"parental help");
    const parentLeft=rewriteParent(leftStatement),parentRight=rewriteParent(rightStatement);
    if(parentLeft!==text(leftStatement) || parentRight!==text(rightStatement)){
      leftStatement=parentLeft;rightStatement=parentRight;
      applied.push({ruleId:"anchored-parent-help",evidence:[primary]});
    }
  }
  return {leftStatement,rightStatement,applied,guards};
}
