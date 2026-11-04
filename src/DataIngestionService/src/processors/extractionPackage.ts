import { Document } from "@langchain/core/documents";
import { get_encoding } from "tiktoken";
import { z } from "zod";
import { ExperimentalMarkdownSyntaxTextSplitter } from "./experimentalMarkdownSyntaxTextSplitter.js";

const integer = z.number().int().nonnegative();
const location = {
  pages: z.array(z.number().int().positive()), regions: z.array(z.string()),
  startTimeMs: integer.nullable().optional(), endTimeMs: integer.nullable().optional(),
  speaker: z.string().nullable().optional(),
};
const blockSchema = z.object({
  id: z.string().min(1), kind: z.string().min(1), origin: z.enum(["extracted", "generated", "artifact"]),
  text: z.string(), ...location,
  serviceSpans: z.array(z.object({ contentIndex: integer, offset: integer, length: integer })),
  keyFrameTimesMs: z.array(integer).nullable().optional(),
});
const assetSchema = z.object({
  id: z.string().min(1), kind: z.enum(["figure", "keyframe"]), containerName: z.string().min(1),
  containerPath: z.string().min(1), url: z.string().url().refine(value => {
    const uri = new URL(value);
    return uri.protocol === "https:" && !uri.username && !uri.password && !uri.search && !uri.hash;
  }, "Image references must use HTTPS without credentials or SAS tokens"),
  contentType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().positive(),
  serviceFilePath: z.string().regex(/^(figures\/[a-zA-Z0-9][a-zA-Z0-9._-]*|keyframes\/[0-9]+)$/),
  blockIds: z.array(z.string()), pages: z.array(z.number().int().positive()), regions: z.array(z.string()),
  timeMs: integer.nullable().optional(),
});
const packageSchema = z.object({
  version: z.literal(1), accountId: z.string().min(1), sourceId: z.string().min(1), mediaType: z.enum(["document", "audio", "video"]),
  provider: z.literal("content-understanding"), analyzerId: z.string().min(1), apiVersion: z.string().min(1),
  analysisId: z.string().min(1), configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), stringEncoding: z.literal("utf16"),
  literalMarkdown: z.string(),
  literalPages: z.array(z.object({ pageNumber: z.number().int().positive(), text: z.string(),
    locationKind: z.enum(["physical-page", "logical-page", "media"]) })).min(1),
  blocks: z.array(blockSchema),
  evidenceLocations: z.array(z.object({ pageNumber: z.number().int().positive(), offset: integer,
    length: integer, blockId: z.string(), ...location })),
  rawResponse: z.unknown(), usage: z.unknown(), warnings: z.array(z.unknown()),
  rendition: z.object({ originalFilename: z.string(), originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    pdfSha256: z.string().regex(/^[a-f0-9]{64}$/), renderer: z.string(), rendererVersion: z.string(),
    containerName: z.string().nullable().optional(), containerPath: z.string().nullable().optional() }).nullable().optional(),
  sourceMetadata: z.object({ date: z.string().nullable().optional(), location: z.string().nullable().optional(),
    description: z.string().nullable().optional() }).nullable().optional(),
  assets: z.array(assetSchema).nullable().optional().transform(value => value ?? []),
});
export type ExtractionPackage = z.infer<typeof packageSchema>;
type Block = ExtractionPackage["blocks"][number];
const PAGE_BREAK = "<!-- PageBreak -->";

export function parseExtractionPackage(value: unknown): ExtractionPackage {
  const result = packageSchema.parse(value);
  const pages = new Map(result.literalPages.map(page => [page.pageNumber, page]));
  const blocks = new Map(result.blocks.map(block => [block.id, block]));
  if (pages.size !== result.literalPages.length || blocks.size !== result.blocks.length)
    throw new Error("Extraction package has duplicate pages or blocks");
  if (new Set(result.assets.map(asset => asset.id)).size !== result.assets.length ||
      result.assets.some(asset => asset.blockIds.some(id => !blocks.has(id))))
    throw new Error("Extraction image has duplicate identity or unknown source block");
  if (result.literalPages.map(page => page.text).join(PAGE_BREAK) !== result.literalMarkdown)
    throw new Error("Extraction package literal pages disagree with its source text");
  for (const block of result.blocks) {
    if ((block.startTimeMs == null) !== (block.endTimeMs == null) ||
        (block.startTimeMs != null && block.endTimeMs! < block.startTimeMs))
      throw new Error("Invalid extraction time range");
    if (result.mediaType !== "document" && block.pages.length) throw new Error("Media cannot have physical page citations");
    if (result.mediaType !== "document" && block.startTimeMs == null && block.origin === "extracted")
      throw new Error("Media transcript has no time location");
  }
  for (const page of result.literalPages) {
    const spans = result.evidenceLocations.filter(span => span.pageNumber === page.pageNumber).sort((a, b) => a.offset - b.offset);
    let end = 0;
    for (const span of spans) {
      const block = blocks.get(span.blockId);
      if (!block || block.origin !== "extracted" || span.offset < end || span.offset + span.length > page.text.length ||
          page.text.slice(span.offset, span.offset + span.length) !== block.text)
        throw new Error("Extraction quotation source is not a literal block");
      if (JSON.stringify(span.pages) !== JSON.stringify(block.pages) || JSON.stringify(span.regions) !== JSON.stringify(block.regions) ||
          span.startTimeMs !== block.startTimeMs || span.endTimeMs !== block.endTimeMs || span.speaker !== block.speaker)
        throw new Error("Extraction quotation location differs from its block");
      if (page.text.slice(end, span.offset).trim()) throw new Error("Unmapped literal quotation source");
      end = span.offset + span.length;
    }
    if (page.text.slice(end).trim()) throw new Error("Unmapped literal quotation source");
  }
  if (result.evidenceLocations.some(span => !pages.has(span.pageNumber))) throw new Error("Unknown quotation page");
  if (result.rendition && result.rendition.pdfSha256 !== result.sourceSha256) throw new Error("PDF rendition hash differs from analyzed source");
  return result;
}

function provenance(pkg: ExtractionPackage): Record<string, unknown> {
  return { extractionVersion: pkg.version, extractionProvider: pkg.provider, analyzerId: pkg.analyzerId,
    apiVersion: pkg.apiVersion, analysisId: pkg.analysisId, configurationHash: pkg.configurationHash,
    originalSourceHash: pkg.rendition?.originalSha256 ?? pkg.sourceSha256, analyzedSourceHash: pkg.sourceSha256,
    rendition: pkg.rendition ?? null, sourceType: pkg.mediaType };
}

export function literalDocument(pkg: ExtractionPackage): Document {
  return new Document({ pageContent: pkg.literalMarkdown, metadata: { ...provenance(pkg),
    pages: pkg.literalPages.map(page => page.pageNumber),
    pageLocationKinds: pkg.literalPages.map(page => page.locationKind), contentOrigin: "extracted",
    ...(pkg.mediaType !== "document" ? { transcriptLocations: pkg.evidenceLocations } : {}),
    sourceMetadata: pkg.sourceMetadata ?? null } });
}

function imagesForBlocks(pkg: ExtractionPackage, ids: string[]) {
  const blocks = new Set(ids);
  return pkg.assets.filter(asset => asset.blockIds.some(id => blocks.has(id)));
}

/** Keep complete tables and paragraphs together; split oversized blocks at text boundaries. */
export function extractionChunks(pkg: ExtractionPackage, maximumTokens = 2000): Document[] {
  if (!Number.isInteger(maximumTokens) || maximumTokens < 32) throw new Error("Chunk token limit must be at least 32");
  const encoding = get_encoding("cl100k_base");
  const documents: Document[] = [];
  try {
    const renderedText = (block: Block) => block.origin === "generated" ? `AI-generated ${block.kind}:\n${block.text}` : block.text;
    // Splitting token bytes can damage Unicode characters. Find a bounded prefix
    // by code point, then prefer a nearby paragraph or word boundary.
    const boundedParts = (text: string): string[] => {
      const points = Array.from(text), parts: string[] = [];
      let offset = 0;
      while (offset < points.length) {
        let low = 1, high = Math.min(points.length - offset, maximumTokens * 8);
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (encoding.encode(points.slice(offset, offset + middle).join("")).length <= maximumTokens - 16) low = middle;
          else high = middle - 1;
        }
        let part = points.slice(offset, offset + low).join("");
        if (offset + low < points.length) {
          const boundary = Math.max(part.lastIndexOf("\n"), part.lastIndexOf(" "));
          if (boundary > part.length / 2) { part = part.slice(0, boundary + 1); low = Array.from(part).length; }
        }
        parts.push(part); offset += low;
      }
      return parts;
    };
    let group: Block[] = [];
    const flush = () => {
      if (!group.length) return;
      const first = group[0];
      const pages = [...new Set(group.flatMap(block => block.pages))].sort((a, b) => a - b);
      const timed = group.filter(block => block.startTimeMs != null);
      documents.push(new Document({ pageContent: group.map(renderedText).join("\n\n"), metadata: {
        ...provenance(pkg), pages, contentOrigin: first.origin, elementType: first.kind,
        blockIds: group.map(block => block.id), regions: [...new Set(group.flatMap(block => block.regions))],
        images: imagesForBlocks(pkg, group.map(block => block.id)),
        serviceSpans: group.flatMap(block => block.serviceSpans),
        ...(timed.length ? { startTimeMs: Math.min(...timed.map(block => block.startTimeMs!)),
          endTimeMs: Math.max(...timed.map(block => block.endTimeMs!)),
          speakers: [...new Set(timed.flatMap(block => block.speaker ? [block.speaker] : []))] } : {}),
      } }));
      group = [];
    };
    for (const block of pkg.blocks) {
      if (!block.text.trim() || block.origin === "artifact") continue;
      const count = encoding.encode(renderedText(block)).length;
      if (group.length && (group[0].origin !== block.origin || block.kind === "table" || group[0].kind === "table" ||
          JSON.stringify(group[0].pages) !== JSON.stringify(block.pages) ||
          encoding.encode([...group.map(renderedText), renderedText(block)].join("\n\n")).length > maximumTokens)) flush();
      if (count > maximumTokens - 16) {
        flush();
        const emit = (text: string) => {
          for (const part of boundedParts(text)) { group = [{ ...block, text: part }]; flush(); }
        };
        // Oversized tables retain their source-region association, and repeat table headers with each row group.
        if (block.kind === "table") {
          const rows = block.text.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
          const caption = block.text.match(/<caption>[\s\S]*?<\/caption>/)?.[0] ?? "";
          const header = rows.find(row => row.includes("<th")) ?? "";
          const suffix = block.text.split("</table>").slice(1).join("</table>");
          let batch: string[] = [];
          for (const row of rows) {
            if (row === header) continue;
            if (batch.length && encoding.encode(`<table>${caption}${header}${batch.join("")}${row}</table>${suffix}`).length > maximumTokens) {
              emit(`<table>${caption}${header}${batch.join("")}</table>${suffix}`); batch = [];
            }
            batch.push(row);
          }
          emit(`<table>${caption}${header}${batch.join("")}</table>${suffix}`);
        } else {
          emit(block.text);
        }
      } else group.push(block);
    }
    flush();
    return documents;
  } finally { encoding.free(); }
}

export function legacySourcePages(text: string): string[] {
  const pages = text.split(PAGE_BREAK);
  if (pages.length > 1 && !pages.at(-1)!.trim()) pages.pop();
  return pages;
}

export function legacyChunks(text: string): Document[] {
  return legacySourcePages(text).flatMap((page, index) => {
    const splitter = new ExperimentalMarkdownSyntaxTextSplitter(null, false, false);
    return splitter.splitText(page).map(doc => new Document({ pageContent: doc.pageContent,
      metadata: { ...doc.metadata, pages: [index + 1], contentOrigin: "extracted" } }));
  });
}

/** Keep evidence algorithm/schema intact; resolve its canonical quotations back to original page/time locations. */
export function attachEvidenceLocations(documents: Document[], pkg: ExtractionPackage): Document[] {
  for (const doc of documents) {
    const spans = doc.metadata.sourceSpans as { pageNumber: number; sourceOffset: number; sourceQuote: string }[];
    const citations = spans.map(span => {
      const matches = pkg.evidenceLocations.filter(location => location.pageNumber === span.pageNumber &&
        location.offset < span.sourceOffset + span.sourceQuote.length && span.sourceOffset < location.offset + location.length);
      if (!matches.length) throw new Error("Evidence quote has no original source location");
      return { canonicalPage: span.pageNumber, canonicalOffset: span.sourceOffset, sourceQuote: span.sourceQuote,
        images: imagesForBlocks(pkg, matches.map(location => location.blockId)),
        pages: [...new Set(matches.flatMap(location => location.pages))],
        regions: [...new Set(matches.flatMap(location => location.regions))],
        startTimeMs: pkg.mediaType === "document" ? undefined : Math.min(...matches.map(location => location.startTimeMs!)),
        endTimeMs: pkg.mediaType === "document" ? undefined : Math.max(...matches.map(location => location.endTimeMs!)),
        ...(pkg.mediaType === "document" ? { locationKind: pkg.literalPages.find(page => page.pageNumber === span.pageNumber)!.locationKind } : {
          locationKind: "media", startTimeMs: Math.min(...matches.map(location => location.startTimeMs!)),
          endTimeMs: Math.max(...matches.map(location => location.endTimeMs!)),
          speakers: [...new Set(matches.flatMap(location => location.speaker ? [location.speaker] : []))],
        }) };
    });
    Object.assign(doc.metadata, provenance(pkg), { citations, contentOrigin: "evidence",
      images: [...new Map(citations.flatMap(citation => citation.images).map(asset => [asset.id, asset])).values()],
      pages: [...new Set(citations.flatMap(citation => citation.pages))] });
    if (pkg.mediaType !== "document") {
      doc.metadata.startTimeMs = Math.min(...citations.map(citation => citation.startTimeMs!));
      doc.metadata.endTimeMs = Math.max(...citations.map(citation => citation.endTimeMs!));
      let citationIndex = 0;
      doc.pageContent = doc.pageContent.replace(/^(Source|Supporting) page: \d+$/gm, (_, label: string) => {
        const citation = citations[citationIndex++];
        return `${label} time (milliseconds): ${citation.startTimeMs}–${citation.endTimeMs}`;
      });
    }
  }
  return documents;
}
