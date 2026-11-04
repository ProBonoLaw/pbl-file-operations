import { Document } from "@langchain/core/documents";
import { z } from "zod";
import { EvidenceSource } from "./evidenceSource.js";

const artifactSchema = z.object({pageContent:z.string(), metadata:z.record(z.unknown())});

/** Immutable source artifacts include the account/source/run identity in their key. */
export class EvidenceSourceCache {
  private readonly sources = new Map<string, Promise<EvidenceSource>>();
  constructor(private readonly load: (id: string) => Promise<unknown>, private readonly maximumChars = 2_000_000) {}

  get(id: string): Promise<EvidenceSource> {
    const cached = this.sources.get(id);
    if (cached) {
      this.sources.delete(id);
      this.sources.set(id, cached);
      return cached;
    }
    const pending = this.load(id).then(value => {
      const artifact = artifactSchema.parse(value);
      // Keep at most two modest documents and their parsed structure in memory.
      // Concurrent readers still share a larger in-flight download.
      if (artifact.pageContent.length + JSON.stringify(artifact.metadata).length > this.maximumChars
        && this.sources.get(id) === pending) this.sources.delete(id);
      return new EvidenceSource(new Document(artifact));
    }).catch((error: unknown) => {
      if (this.sources.get(id) === pending) this.sources.delete(id);
      throw error;
    });
    this.sources.set(id, pending);
    while (this.sources.size > 2) this.sources.delete(this.sources.keys().next().value!);
    return pending;
  }
}
