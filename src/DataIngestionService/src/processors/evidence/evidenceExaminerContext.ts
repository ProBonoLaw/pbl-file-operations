import type { ConsistencyRecord } from "./evidenceConsistency.js";
import type { SourceSpan } from "./evidenceSource.js";

const clean=(value:string)=>value.normalize("NFKC").replace(/[’‘]/g,"'").replace(/\s+/g," ").trim().toLowerCase();
const name=(value:string)=>clean(value).replace(/,\s*(?:ph\.?d\.?|psy\.?d\.?|m\.?d\.?|ed\.?d\.?)$/," ")
  .match(/[\p{L}\p{N}]+/gu)?.join(" ")??"";
const sameSpan=(a:SourceSpan,b:SourceSpan)=>a.pageNumber===b.pageNumber&&a.sourceOffset===b.sourceOffset&&a.sourceQuote===b.sourceQuote;
const months=["january","february","march","april","may","june","july","august","september","october","november","december"];
const missing=(value:unknown)=>value===undefined||value===null||value==="";
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==="object"&&!Array.isArray(value) ? value as Record<string,unknown> : null;
const emptyDate=(value:unknown)=>missing(value)||Boolean(object(value)&&Object.values(object(value)!).every(missing));

function statement(value:string){
  const match=clean(value).match(/^an interview and examination session for (.+?) took place on ([a-z]+) (\d{1,2}), (\d{4})(?:, with (.+?) identified as examiner)?\.$/);
  if(!match)return null;
  const month=months.indexOf(match[2])+1,day=Number(match[3]),year=Number(match[4]);
  const date=new Date(Date.UTC(year,month-1,day));
  if(!month||year<1000||date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day)return null;
  return {subject:name(match[1]),examiner:match[5]?name(match[5]):null,month,day,year,date:`${match[2]} ${day}, ${year}`};
}

function datedAs(record:ConsistencyRecord,event:NonNullable<ReturnType<typeof statement>>):boolean {
  const dates=object(record.fields.dates),start=object(dates?.whenStarted);
  // Unknown/ranged/relative dates and other date roles need their own review.
  return Boolean(dates&&start&&String(start.year)===String(event.year)&&String(start.month)===String(event.month)&&String(start.day)===String(event.day)
    && missing(start.season)&&missing(start.quarter)&&emptyDate(dates.whenEnded)&&emptyDate(dates.asOf)&&missing(dates.eventDateResolution));
}

function sourceDate(quote:string,event:NonNullable<ReturnType<typeof statement>>):boolean {
  const header=clean(quote).match(/^(?:\*\*)?interview and examination dates:(?:\*\*)?\s*(.+)$/);
  if(!header)return false;
  const body=header[1];
  const datePattern=`(?:${months.join("|")}) \\d{1,2}, \\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/(?:\\d{4}|\\d{2})`;
  // A date mention qualified as cancelled, proposed, excluded or a range is
  // not proof that the examination happened on that date.
  if(!new RegExp(`^(?:${datePattern})(?:\\s*(?:,|;|and)\\s*(?:${datePattern}))*\\.?$`).test(body))return false;
  if(new RegExp(`\\b${event.date}\\b`).test(body))return true;
  for(const match of body.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g))
    if(Number(match[1])===event.year&&Number(match[2])===event.month&&Number(match[3])===event.day)return true;
  // Do not assume a locale for ambiguous slash dates. A two-digit year matches
  // only the suffix of the already identical, fully specified statement dates.
  if(event.day<=12)return false;
  return [...body.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/g)].some(match=>
    Number(match[1])===event.month&&Number(match[2])===event.day
    &&Number(match[3])===(match[3].length===2 ? event.year%100 : event.year));
}

/** Contextual enrichment for one dated examination, never a global alias map.
 * Inputs have already had all citations verified against the frozen source.
 */
export function normalizeExaminerContext(left:ConsistencyRecord,right:ConsistencyRecord):{
  leftStatement:string;rightStatement:string;evidence:SourceSpan[];
}|null {
  const primary=left.sourceSpans[0],other=right.sourceSpans[0];
  if(!primary||!other||!sameSpan(primary,other)||!left.sourceId||!left.sourceContentHash
    ||left.sourceId!==right.sourceId||left.sourceContentHash!==right.sourceContentHash||left.documentGroup!==right.documentGroup)return null;
  const a=statement(left.statement),b=statement(right.statement);
  if(!a||!b||Boolean(a.examiner)===Boolean(b.examiner)||a.date!==b.date||!datedAs(left,a)||!datedAs(right,b)||!sourceDate(primary.sourceQuote,a))return null;
  const headers=(label:string)=>{
    const expression=new RegExp(`^(?:\\*\\*)?${label}:(?:\\*\\*)?\\s*(.+)$`,"i");
    const all=[...left.sourceSpans,...right.sourceSpans].filter(span=>span.pageNumber===primary.pageNumber&&span.sourceOffset<primary.sourceOffset
      &&primary.sourceOffset-span.sourceOffset<=2048&&!/[\r\n]/.test(span.sourceQuote)&&expression.test(span.sourceQuote.trim()));
    const distinct=[...new Map(all.map(span=>[JSON.stringify(span),span])).values()];
    if(distinct.length!==1)return null;
    const span=distinct[0];
    return left.sourceSpans.some(item=>sameSpan(item,span))&&right.sourceSpans.some(item=>sameSpan(item,span))
      ? {span,value:name(span.sourceQuote.trim().match(expression)![1])} : null;
  };
  const client=headers("Client"),examiner=headers("Examiner");
  if(!client?.value||!examiner?.value||(a.examiner??b.examiner)!==examiner.value)return null;
  if(a.subject!==client.value&&b.subject!==client.value)return null;
  const isSubject=(candidate:string)=>candidate===client.value ||
    // A short given/middle name is usable only in this uniquely cited client
    // context, with the full client name explicit in the other assertion.
    (candidate.length>1&&!candidate.includes(" ")&&client.value.split(" ").slice(0,-1).includes(candidate)
      &&!examiner.value.split(" ").includes(candidate));
  if(!isSubject(a.subject)||!isSubject(b.subject))return null;
  for(const [record,event]of [[left,a],[right,b]] as const){
    const people=record.fields.people.map(name);
    if(!people.includes(event.subject)||!people.includes(examiner.value)||people.some(person=>person!==examiner.value&&!isSubject(person)))return null;
    if(record.fields.claimant.trim()&&name(record.fields.claimant)!==examiner.value)return null;
  }
  const canonical=`An interview and examination session for ${client.value} took place on ${a.date}, with ${examiner.value} identified as examiner.`;
  return {leftStatement:canonical,rightStatement:canonical,evidence:[primary,client.span,examiner.span]};
}
