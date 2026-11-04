import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import type { EvidenceWindow, SourceSpan } from "./evidenceSource.js";

interface Heading { start: number; end: number; level: number }
interface Table { start: number; end: number; headerStart: number; headerEnd: number; rowEnds: number[] }
export interface GatheringStructure { headings: Heading[]; tables: Table[]; blockEnds: number[]; unitEnds: number[] }
const markdown = unified().use(remarkParse).use(remarkGfm);
type HtmlNode = DefaultTreeAdapterMap["node"];
const children = (node: HtmlNode): HtmlNode[] => "childNodes" in node ? node.childNodes : [];
const containsHeader = (node: HtmlNode): boolean => "tagName" in node && node.tagName === "th" || children(node).some(containsHeader);

/** Parse formatting only. Offsets always refer to the original source, never rendered Markdown. */
export function parseGatheringStructure(text: string): GatheringStructure {
  const structure: GatheringStructure = {headings:[], tables:[], blockEnds:[], unitEnds:[]};
  const tree = markdown.parse(text);
  const countUnits = (node: typeof tree | typeof tree.children[number]) => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (node.type === "paragraph") {
        for (const match of text.slice(start, end).matchAll(/[.!?](?:[)"'\]]?)(?:\s+|$)/g))
          structure.unitEnds.push(start + match.index + match[0].length);
        structure.unitEnds.push(end);
      }
      if (node.type === "code") {
        for (const match of text.slice(start, end).matchAll(/\r?\n/g)) structure.unitEnds.push(start + match.index + match[0].length);
        structure.unitEnds.push(end);
      }
    }
    if (node.type === "root" || node.type === "blockquote") node.children.forEach(countUnits);
    if (node.type === "list") node.children.forEach(item => item.children.forEach(countUnits));
  };
  countUnits(tree);
  for (const node of tree.children) {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    structure.blockEnds.push(end);
    if (node.type === "heading") structure.headings.push({start, end, level:node.depth});
    // Some OCR providers emit titles as a standalone bold paragraph.
    if (node.type === "paragraph" && node.children.length === 1 && node.children[0].type === "strong"
      && node.position!.start.line === node.position!.end.line && end - start <= 160)
      structure.headings.push({start, end, level:2});
    if (node.type === "table") {
      const rowEnds = node.children.map(row => row.position!.end.offset!);
      structure.tables.push({start, end, headerStart:start, headerEnd:node.children[1]?.position?.start.offset ?? end, rowEnds});
      structure.unitEnds.push(...rowEnds);
    }
    if (node.type !== "html") continue;
    // Content Understanding also emits raw HTML headings and tables. parse5
    // supplies their original offsets without executing or rendering the HTML.
    const fragment = parseFragment(text.slice(start, end), {sourceCodeLocationInfo:true});
    const visit = (element: HtmlNode, table?: Table) => {
      if (!("tagName" in element)) { children(element).forEach(child => visit(child, table)); return; }
      const location = element.sourceCodeLocation;
      if (location) {
        const elementStart = start + location.startOffset, elementEnd = start + location.endOffset;
        if (element.tagName === "p" || element.tagName === "li") structure.unitEnds.push(elementEnd);
        if (!table && /^h[1-6]$/.test(element.tagName)) structure.headings.push({start:elementStart, end:elementEnd, level:Number(element.tagName[1])});
        if (element.tagName === "table") {
          table = {start:elementStart, end:elementEnd, headerStart:elementStart, headerEnd:elementStart, rowEnds:[]};
          structure.tables.push(table);
        }
        if (element.tagName === "tr" && table) {
          table.rowEnds.push(elementEnd);
          structure.unitEnds.push(elementEnd);
          if (containsHeader(element) && (table.rowEnds.length === 1 || table.headerEnd === table.rowEnds.at(-2))) {
            if (table.rowEnds.length === 1) table.headerStart = elementStart;
            table.headerEnd = elementEnd;
          }
        }
      }
      children(element).forEach(child => visit(child, table));
    };
    visit(fragment);
  }
  structure.headings.sort((a,b) => a.start - b.start);
  structure.unitEnds = [...new Set(structure.unitEnds)].sort((a,b) => a - b);
  return structure;
}

/** Keep consecutive titles with their body; never combine bodies from distinct titled sections. */
export function titledSectionStarts(text: string, headings = parseGatheringStructure(text).headings): number[] {
  const starts = [0];
  let previousHeadingEnd = 0;
  for (const heading of headings) {
    if (text.slice(previousHeadingEnd, heading.start).trim() && heading.start > starts.at(-1)!) starts.push(heading.start);
    previousHeadingEnd = heading.end;
  }
  return starts;
}

/** Supply exact enclosing titles and table headers that fall outside a small target. */
export function gatheringStructuralContext(pages: readonly {pageNumber: number; text: string}[], window: EvidenceWindow,
  structureForPage: (pageNumber: number) => GatheringStructure): SourceSpan[] {
  const hierarchy: Array<SourceSpan & {level: number}> = [];
  const pageIndex = pages.findIndex(page => page.pageNumber === window.pageNumber);
  for (const page of pages.slice(0, pageIndex + 1)) {
    for (const heading of structureForPage(page.pageNumber).headings) {
      if (page.pageNumber === window.pageNumber && heading.start > window.startOffset) break;
      while (hierarchy.length && hierarchy.at(-1)!.level >= heading.level) hierarchy.pop();
      hierarchy.push({level:heading.level, pageNumber:page.pageNumber, sourceOffset:heading.start,
        sourceQuote:page.text.slice(heading.start, heading.end)});
    }
  }
  const context: SourceSpan[] = hierarchy.map(({level: _level, ...span}) => span).filter(span =>
    span.sourceQuote.length <= 1500 && (span.pageNumber !== window.pageNumber || span.sourceOffset < window.startOffset));
  const pageText = pages[pageIndex].text;
  for (const table of structureForPage(window.pageNumber).tables) {
    if (table.start <= window.startOffset && table.end > window.startOffset && table.headerStart < window.startOffset
      && table.headerEnd > table.headerStart && table.headerEnd - table.headerStart <= 1500)
      context.push({pageNumber:window.pageNumber, sourceOffset:table.headerStart, sourceQuote:pageText.slice(table.headerStart, table.headerEnd)});
  }
  return context;
}
