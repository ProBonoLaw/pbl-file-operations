export const EVIDENCE_LOCATION_INSTRUCTIONS = [
  "LOCATION SUPPORT: locationContext contains exact facility and encounter passages, not an assigned document-wide location. Resolve the place of the occurrence, observation, or proposition from the target together with its applicable source context.",
  "A named hospital or clinic encounter header can establish the location of that encounter's examinations, measurements, treatment, patient observations, and care handoffs even when each target line does not repeat the facility name. Verify that the target continues the same encounter or report, and cite the facility header and any passage needed to establish that link in supportingQuotes. Use the source-supported facility name, retaining a department or room only when supported. Do not carry a facility across a different report, encounter, or conflicting location.",
  "A report's facility or mailing address alone does not locate historical events, home or school circumstances, external treatment, generic medical information, proposed transfers, or the underlying occurrence described in a claim. The place where a claim is recorded is not automatically the place its proposition concerns. Electronic signatures do not establish the signer's physical location. A telehealth encounter may establish the patient's facility while the remote clinician's physical location remains unknown; do not imply they were co-located.",
  "Resolve Unknown places when the supplied source positively links the item to its encounter facility. Preserve Unknown when the link is absent or ambiguous; never fill every record with the hospital name merely because it appears in a header.",
].join("\n");

/** Source fidelity, not an assessment of a witness's credibility or real-world truth. */
export const EVIDENCE_FIELD_SUPPORT_INSTRUCTIONS = [
  "FIELD SUPPORT CHECK: Check the occurrence/proposition, participants, original speaker, negation, modality, location, cause and time separately against the source. For each material field distinguish supported, contradicted and not established; do not output a separate checklist.",
  "Use a sufficient set of source passages together, including explicit cross-page links. A matching quotation, nearby name, report date or shared topic alone does not establish every field. Another complete evidence set is acceptable; cite every passage needed for the interpretation.",
  EVIDENCE_LOCATION_INSTRUCTIONS,
  "Preserve a supported occurrence when an incidental date, participant, place or cause is not established. Correct only unsupported fields to the schema's unknown value; do not reject the entire event or invent a replacement date. If the occurrence itself is only alleged, hypothetical, recommended or planned, preserve the supported attributed claim instead of asserting that it happened.",
  "Preserve who said what and the scope of not, may, could, reportedly and similar qualifications. A report author's record of a parent's statement does not make the author its original speaker. Two opposing attributed statements can both be supported as claims without either underlying assertion being established as fact.",
  "Missing retrieved context is not a contradiction or proof of absence. Use available source tools when a material link is missing. If core support remains indeterminate, use the existing unresolved decision; if only incidental fields remain unknown, preserve the supported item. A correction reason should briefly identify the affected field and source relationship, not provide a reasoning transcript.",
].join("\n");

// These are observed processing issues. Only an annotated evaluation can tell
// whether the model actually missed evidence or interpreted it incorrectly.
export type EvidenceReviewIssue = "schema" | "citation" | "date-format" | "source-support" | "loop";
