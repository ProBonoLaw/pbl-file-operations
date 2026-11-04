import { Document } from "@langchain/core/documents";

type HeaderType = [number, string]; // [header depth, header text]

export class ExperimentalMarkdownSyntaxTextSplitter {
  private chunks: Document[] = [];
  private currentChunk: Document = new Document({ pageContent: "", metadata: {} });
  private currentHeaderStack: HeaderType[] = [];
  private stripHeaders: boolean;
  private splittableHeaders: Record<string, string>;
  private returnEachLine: boolean;

  private static readonly DEFAULT_HEADER_KEYS: Record<string, string> = {
    "#": "Header 1",
    "##": "Header 2",
    "###": "Header 3",
    "####": "Header 4",
    "#####": "Header 5",
    "######": "Header 6",
  };

  constructor(
    headersToSplitOn: [string, string][] | null = null,
    returnEachLine: boolean = false,
    stripHeaders: boolean = true
  ) {
    this.stripHeaders = stripHeaders;
    this.returnEachLine = returnEachLine;

    if (headersToSplitOn) {
      this.splittableHeaders = Object.fromEntries(headersToSplitOn);
    } else {
      this.splittableHeaders = ExperimentalMarkdownSyntaxTextSplitter.DEFAULT_HEADER_KEYS;
    }
  }

  public splitText(text: string): Document[] {
    this.resetState();

    const rawLines = text.split(/\r?\n/);

    while (rawLines.length > 0) {
      const rawLine = rawLines.shift()!;
      const headerMatch = this.matchHeader(rawLine);
      const codeMatch = this.matchCode(rawLine);
      const horzMatch = this.matchHorizontalRule(rawLine);

      if (headerMatch) {
        this.completeChunkDoc();

        if (!this.stripHeaders) {
          this.currentChunk.pageContent += rawLine + "\n";
        }

        const headerDepth = headerMatch[1].length;
        const headerText = headerMatch[2];
        this.resolveHeaderStack(headerDepth, headerText);
      } else if (codeMatch) {
        this.completeChunkDoc();
        this.currentChunk.pageContent = this.resolveCodeChunk(rawLine, rawLines);
        this.currentChunk.metadata["Code"] = codeMatch[1] || "";
        this.completeChunkDoc();
      } else if (horzMatch) {
        this.completeChunkDoc();
      } else {
        this.currentChunk.pageContent += rawLine + "\n";
      }
    }

    this.completeChunkDoc();

    if (this.returnEachLine) {
      return this.chunks.flatMap((chunk) =>
        chunk.pageContent
          .split(/\r?\n/)
          .filter((line) => line.trim() !== "")
          .map((line) => new Document({ pageContent: line, metadata: chunk.metadata }))
      );
    }

    return this.chunks;
  }

  private resetState(): void {
    this.chunks = [];
    this.currentChunk = new Document({ pageContent: "", metadata: {} });
    this.currentHeaderStack = [];
  }

  private resolveHeaderStack(headerDepth: number, headerText: string): void {
    for (let i = 0; i < this.currentHeaderStack.length; i++) {
      const [depth] = this.currentHeaderStack[i];
      if (depth === headerDepth) {
        this.currentHeaderStack[i] = [headerDepth, headerText];
        this.currentHeaderStack = this.currentHeaderStack.slice(0, i + 1);
        return;
      }
    }
    this.currentHeaderStack.push([headerDepth, headerText]);
  }

  private resolveCodeChunk(currentLine: string, rawLines: string[]): string {
    let chunk = currentLine + "\n";
    while (rawLines.length > 0) {
      const rawLine = rawLines.shift()!;
      chunk += rawLine + "\n";
      if (this.matchCode(rawLine)) {
        break;
      }
    }
    return chunk;
  }

  private completeChunkDoc(): void {
    const chunkContent = this.currentChunk.pageContent.trim();
    if (chunkContent) {
      for (const [depth, value] of this.currentHeaderStack) {
        const headerKey = this.splittableHeaders["#".repeat(depth)];
        if (headerKey) {
          this.currentChunk.metadata[headerKey] = value;
        }
      }
      this.chunks.push(this.currentChunk);
    }
    this.currentChunk = new Document({ pageContent: "", metadata: {} });
  }

  private matchHeader(line: string): RegExpMatchArray | null {
    const match = line.match(/^(#{1,6}) (.*)/);
    if (match && this.splittableHeaders[match[1]]) {
      return match;
    }
    return null;
  }

  private matchCode(line: string): RegExpMatchArray | null {
    return line.match(/^(```|~~~)(.*)?/);
  }

  private matchHorizontalRule(line: string): RegExpMatchArray | null {
    return line.match(/^(---|\*\*\*|___)\s*$/);
  }
}
