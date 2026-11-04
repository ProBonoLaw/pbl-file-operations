import { z } from "zod";

export const EVIDENCE_TAXONOMY_VERSION = "1";

const EVENT_TYPES = [
  "communication", "transaction", "meeting", "movement", "observation",
  "filing", "hearing", "agreement", "payment", "medicalTreatment",
  "lawEnforcementAction", "employmentAction", "assessment", "educationAction",
  "documentExecution", "legalAction", "careChange", "conflict", "avoidance",
  "accident", "injury", "death", "lifeEvent", "other",
] as const;

const eventDefinitions: Record<typeof EVENT_TYPES[number], string> = {
  communication: "sending, receiving, or speaking a message",
  transaction: "exchange or transfer of assets; use payment for money paid",
  meeting: "people convening; use hearing for a formal adjudicative proceeding",
  movement: "travel, arrival, departure, or relocation",
  observation: "an act of observing behavior or an occurrence, never a static score",
  filing: "submitting a document to a court, agency, or registry",
  hearing: "a court, tribunal, or administrative hearing",
  agreement: "reaching an agreement, granting consent, or adopting a plan",
  payment: "paying, refunding, or disbursing money",
  medicalTreatment: "therapy, medication administration, surgery, or other treatment",
  lawEnforcementAction: "police investigation, arrest, search, or enforcement",
  employmentAction: "hiring, dismissal, discipline, or another employment change",
  assessment: "administering, taking, or completing a test, checklist, examination, or evaluation; scores belong in facts",
  educationAction: "enrollment, school completion, instruction, or implementing an accommodation",
  documentExecution: "signing, witnessing, or notarizing a document; filing it is a separate action",
  legalAction: "legal steps not covered by filing, hearing, or agreement, such as issuing an order",
  careChange: "admission, discharge, placement, or removal from care",
  conflict: "an argument, dispute, confrontation, or clash between people or parties; inconsistent statements alone are not a conflict event",
  avoidance: "source-supported deliberate evasion of payment, law enforcement, communication, or another obligation or interaction; nonperformance alone does not establish intent",
  accident: "an accidental occurrence such as a fall or vehicle collision; do not infer fault, negligence, or injury",
  injury: "an occurrence of physical harm or an acute medical incident",
  death: "an occurrence of death; preserve stated circumstances without inferring cause",
  lifeEvent: "birth, marriage, or another personal status change; use death for a death",
  other: "only a dated occurrence outside all listed categories; an unknown date is not a reason to choose other",
};

const FACET_NAMESPACES = [
  "communication", "legal", "procedural", "financial", "evidence",
  "relationship", "employment", "medical", "education",
] as const;
type FacetNamespace = typeof FACET_NAMESPACES[number];
interface Facet { namespace: FacetNamespace; value: string }

// Preferred spellings, not a closed vocabulary. Only spelling is normalized;
// related concepts (e.g. diagnosis and suspectedDiagnosis) remain distinct.
const facetExamples: Record<FacetNamespace, readonly string[]> = {
  communication: ["email", "telephoneCall", "interview", "writtenNotice", "communicationAvoidance", "unansweredCommunication"],
  legal: ["consent", "courtOrder", "assault", "legalProceeding", "lawEnforcementEvasion"],
  procedural: ["assessmentCompleted", "documentSigned", "planAdopted", "deadline"],
  financial: ["invoice", "refund", "arrears", "accountBalance", "nonpayment", "paymentAvoidance"],
  evidence: ["assessmentResult", "standardizedScore", "witnessAccount", "documentIdentity"],
  relationship: ["parentChild", "marriage", "guardianship", "dispute"],
  employment: ["hiring", "dismissal", "workplaceAccommodation"],
  medical: ["psychologicalAssessment", "diagnosis", "suspectedDiagnosis", "symptomReport", "treatmentRecommendation", "fall", "death"],
  education: ["academicAssessment", "schoolEnrollment", "schoolCompletion", "learningAccommodation", "readingInstruction"],
};

export const EVIDENCE_CLASSIFICATION_INSTRUCTIONS = [
  "A factualAssertion claim requires source-supported attribution of asserted content. Do not use it as a catch-all for every declarative statement or label a recorded identity, attribute, measurement, reference number or transaction as a claim merely because a document or author states it. Preserve actual allegations, opinions, denials and uncertainty as claims. Classify direct records by the evidence they express; do not infer a speaker from the subject of a form field.",
  "CLASSIFICATION: Choose the most specific applicable type from the schema. Classify the action itself, not the document containing it. An indexed event requires a source-supported calendar date or bounded occurrence date. If no date is established, retain a source-supported occurrence as an undatedOccurrence fact, or as an attributed claim when it is reported or alleged. Do not borrow a date from a nearby incident or use eventType:other to hide missing dates. Use other only when no listed type fits.",
  "Use assessment for taking/completing a test or checklist, documentExecution for signing, agreement for consent or adopting a plan, and educationAction for school enrollment/completion or implementing instruction/accommodations. A recommendation to act remains a claim, not an event that the action occurred.",
  "Use conflict for an actual dispute or confrontation, not merely contradictions between records. Use avoidance only when the source supports deliberate evasion, such as refusing payment to evade a bill, fleeing law enforcement, or deliberately avoiding contact. An unpaid bill or unanswered message alone does not establish avoidance: nonpayment and unansweredCommunication facets preserve those limited facts without inferring motive. Allegations of avoidance remain attributed claims unless the underlying event is independently supported.",
  "Use accident for an accidental fall, vehicle collision, or other mishap, and death when a death occurred. Do not label a stated intentional act accidental. Distinguish the accident from any injury or death; extract each consequence separately only when the source supports it, without inferring causation.",
  "Add specific source-supported domain facets to events, facts, AND claims. Prefer 1-3 useful facets when a domain is identifiable; use [] only when none is supported. Do not tag every item with the document's general subject. Avoid generic values such as other, unknown, general, fact, event, or claim.",
  "Use these preferred facet values when they describe the item; other specific camelCase values are allowed: "
    + Object.entries(facetExamples).map(([namespace, values]) => `${namespace}: ${values.join(", ")}`).join("; ") + ".",
  "Facet values describe the asserted subject matter, not a finding of truth. Preserve claimant, polarity, and qualifiers: a suspected diagnosis is not a confirmed diagnosis, and an allegation of assault is not proof that an assault occurred. Do not infer legal conclusions or credibility from tags.",
].join("\n");

// Return fresh schemas so LangChain never emits cross-property $ref entries.
export const eventTypeField = () => z.enum(EVENT_TYPES).describe(
  EVENT_TYPES.map(type => `${type}: ${eventDefinitions[type]}`).join("; "),
);

export const facetsField = () => z.array(z.object({
  namespace: z.enum(FACET_NAMESPACES).describe("Domain of this specific item, not of the whole document."),
  value: z.string().trim().min(1).describe("Specific camelCase classification. Prefer the provided vocabulary where applicable; new specific values are allowed. Preserve distinctions such as suspectedDiagnosis versus diagnosis."),
})).describe("Source-supported domain classifications for this event, fact, or claim. Prefer 1-3 specific facets when applicable; [] only when no domain classification is supported.");

function tagPart(value: string): string | null {
  const words = value.trim().split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (!words.length) return null;
  return words.map((word, index) => index === 0
    ? word[0].toLowerCase() + word.slice(1)
    : word[0].toUpperCase() + word.slice(1)).join("");
}

export function facetTags(facets: readonly Facet[]): string[] {
  return [...new Set(facets.flatMap(({ namespace, value }) => {
    const normalized = tagPart(value);
    if (!normalized) return [];
    const canonical = facetExamples[namespace].find(example => example.toLowerCase() === normalized.toLowerCase()) ?? normalized;
    return [`facet:${namespace}:${canonical}`];
  }))];
}

/** When identical evidence is merged, a specific type supersedes its fallback. */
export function removeSupersededOtherTags(tags: string[]): string[] {
  return tags.filter(tag => {
    const match = /^(eventType|factType|claimType):other$/.exec(tag);
    return !match || !tags.some(other => other.startsWith(`${match[1]}:`) && other !== tag);
  });
}

export function classificationIssues(item: { eventType?: string; factType?: string; claimType?: string; facets: Facet[] }): string[] {
  const issues: string[] = [];
  if ([item.eventType, item.factType, item.claimType].includes("other")) {
    issues.push("Type is other: check whether a defined category fits the source-supported item.");
  }
  if (!item.facets.length) issues.push("No domain facets: add a specific facet if the source supports one.");
  if (item.facets.some(facet => /^(other|unknown|general|miscellaneous|fact|event|claim)$/i.test(facet.value.trim())
    || facet.value.trim().toLowerCase() === facet.namespace)) {
    issues.push("Generic facet: replace it with a specific supported classification, or remove it if none is supported.");
  }
  return issues;
}

/** Counts are diagnostics, not relevance scores or grounds for dropping evidence. */
export function summarizeEvidenceTaxonomy(documents: readonly { metadata: Record<string, unknown> }[]) {
  const empty = () => ({ count: 0, otherTypeCount: 0, noFacetCount: 0, types: {} as Record<string, number> });
  const summary = { event: empty(), fact: empty(), claim: empty() };
  for (const { metadata } of documents) {
    const tags = Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const kind = metadata.claimType ? "claim" : metadata.factType ? "fact" : tags.includes("event") ? "event" : null;
    if (!kind) continue;
    const group = summary[kind];
    const type = typeof metadata[`${kind}Type`] === "string" ? metadata[`${kind}Type`] as string
      : tags.find(tag => tag.startsWith(`${kind}Type:`))?.slice(`${kind}Type:`.length) ?? "unknown";
    group.count++;
    group.types[type] = (group.types[type] ?? 0) + 1;
    if (type === "other") group.otherTypeCount++;
    if (!tags.some(tag => tag.startsWith("facet:"))) group.noFacetCount++;
  }
  return summary;
}
