import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

let implementationFingerprint: Promise<string> | undefined;

export function currentImplementationFingerprint(): Promise<string> {
  implementationFingerprint ??= (async () => {
    const suffix = extname(fileURLToPath(import.meta.url));
    const files = [new URL(import.meta.url), new URL(`./evidenceExtractor${suffix}`, import.meta.url), new URL(`./evidenceSource${suffix}`, import.meta.url),
      new URL(`./evidenceModels${suffix}`, import.meta.url), new URL(`./evidenceTaxonomy${suffix}`, import.meta.url),
      new URL(`./evidenceDeduplication${suffix}`, import.meta.url),
      new URL(`./evidenceDocumentDeduplication${suffix}`, import.meta.url),
      new URL(`./evidenceCanonicalizationPrompt${suffix}`, import.meta.url),
      new URL(`./evidenceSourceLookup${suffix}`, import.meta.url),
      new URL(`./evidenceSourceRanking${suffix}`, import.meta.url),
      new URL(`./createEvidenceSourceLookup${suffix}`, import.meta.url),
      new URL(`../searchClientOptions${suffix}`, import.meta.url),
      new URL(`./evidenceSearchLookup${suffix}`, import.meta.url),
      new URL(`./sourcePartitionSearch${suffix}`, import.meta.url),
      new URL(`./evidenceEmbeddingCache${suffix}`, import.meta.url),
      new URL(`./evidenceSemanticReview${suffix}`, import.meta.url),
      new URL(`./evidenceConditionComparison${suffix}`, import.meta.url),
      new URL(`./evidenceMetadataReview${suffix}`, import.meta.url),
      new URL(`./evidenceRecommendationReference${suffix}`, import.meta.url),
      new URL(`./evidenceMissingDate${suffix}`, import.meta.url),
      new URL(`./evidencePageIdentity${suffix}`, import.meta.url),
      new URL(`./evidenceCanonicalization${suffix}`, import.meta.url),
      new URL(`./evidenceReviewBatching${suffix}`, import.meta.url),
      new URL(`./evidenceReconciliation${suffix}`, import.meta.url)];
    files.push(new URL(`./evidenceCitationResolution${suffix}`, import.meta.url), new URL(`./evidenceFastReview${suffix}`, import.meta.url), 
      new URL(`./evidenceReconciliationDeadline${suffix}`, import.meta.url),
      new URL(`./evidenceGathering${suffix}`, import.meta.url),
      new URL(`./evidenceGatheringSections${suffix}`, import.meta.url),
      new URL(`./evidencePrompt${suffix}`, import.meta.url),
      new URL(`./evidenceCompactPrompt${suffix}`, import.meta.url),
      new URL(`./evidenceCompactResponses${suffix}`, import.meta.url),
      new URL(`./evidenceReconciliationAdmission${suffix}`, import.meta.url),
      new URL(`./evidenceAsync${suffix}`, import.meta.url));
    files.push(...["evidenceDocumentContext", "evidenceEventDates", "evidenceEventDatePolicy", "evidenceReviewDecisions", "evidenceIdentityReview", "evidenceAtomicity", "evidenceContent", "evidenceReviewRouting", "evidenceAttribution", "evidenceSupport", "evidenceEventStructure", "evidenceEventMentions", "evidenceClassification", "evidenceSkills", "evidenceCandidateDeduplication"]
      .map(name => new URL(`./${name}${suffix}`, import.meta.url)));
    files.push(...["evidenceExtractionSchemas", "evidenceExtractionDates", "evidenceDocumentFactory",
      "evidenceExtractionValidation", "evidenceStageCheckpoints", "evidenceStructuredInvocation",
      "evidenceCanonicalizationReview", "evidenceCanonicalizationReviewBatch", "evidenceCanonicalizationQueue",
      "evidenceCooperativeComputation",
      "evidenceReviewCoordinator", "evidenceDecisionReview", "evidenceEnrichmentReview"]
      .map(name => new URL(`./${name}${suffix}`, import.meta.url)));
    const hash = createHash("sha256");
    for (const content of await Promise.all(files.map(file => readFile(file)))) hash.update(content);
    hash.update(await readFile(new URL(suffix === ".ts" ? "../../../bun.lock" : "./evidenceDependencies.sha256", import.meta.url)));
    return hash.digest("hex");
  })().catch((error: unknown) => {
    implementationFingerprint = undefined;
    throw error;
  });
  return implementationFingerprint;
}

