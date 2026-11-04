# Identity examples

- “Casey paid 250 dollars” extracted as an event, a recorded-value fact and an
  asserting claim can be one assertion when the account, source, page, participants,
  timing and source support agree. Retain all classifications/tags and the event
  representation. A different amount, a denial or a different payer remains distinct.
- Two extractions of “The permit number is 12345” can describe the same recorded
  value even when one quotes a table cell and the other quotes the narrative on
  the same page. Quotations need not overlap; the assertion and source identity
  still must agree. The same wording on another page remains a separate record.

- A source explicitly defines “Child Learning Checklist (CLC)”. When both
  statements identify the same administration and result, expanding CLC to that
  full name does not add a separate assertion. Do not infer an expansion if the
  source gives none, or if another instrument uses the same abbreviation.
- “Casey performed comparably on the Learning Scale's Pattern and Picture
  subtests” and “The examiner describes Casey's Pattern and Picture performance
  as comparable” can describe the same result when their citations establish
  the same instrument, subtests and assessment. Inventory the added instrument
  identifier and keep the fuller statement; different instruments stay distinct.
- “Parents should set aside expectations that might make activities tenser” and
  “Casey's parents should set aside those expectations, because the goal is to
  create a warm, safe environment” can describe the same recommendation. Inventory
  the stated goal and retain it. “Parents should set aside expectations and arrange
  another session” adds a different action; “the environment became safe” asserts
  an outcome. Both remain separate even in the same scenario or source passage.
- “The named Memory Index overall score was 112, percentile 79” and “The named
  Memory Index score was 112, percentile 79, high average” refer to the same
  result if the cited row and narrative confirm it. The classification is new;
  `overall` is not a second result here. An overall battery score versus a
  subtest score remains distinct, even when both values happen to be 112.
- Read parenthetical assertion text: “The mother-rated score was average
  (the mother Attention score was 107)” already includes the Attention measure
  and score. Compared with “The mother Attention score was 107, average,
  percentile 68”, only the percentile is additional. The source quotation
  alone would not fill those fields if the assertion did not contain them.

- “Scaled scores have mean 10” and “Standard scores have mean 100 and scaled
  scores have mean 10” are `independent_assertions`: different measures, even
  though the complete first assertion occurs in the second.
- “The scale assesses social behavior” and “The scale assesses social behavior
  and contains five subscales” add the separate property of scale composition.
- “The clinician recommends tutoring” and “The clinician recommends tutoring,
  parent reading and self-reading” contain different sets of recommendations.
  Report the additional interventions in the detail inventory, rather than
  labeling the whole list compatible specificity of tutoring.
- “Scores suggest no disorder” and “Scores suggest adequate social skills with
  no disorder” add a different qualified proposition about social functioning.

- “The dispatcher sent a warning” and “The dispatcher sent a stop instruction
  thirty seconds after the warning” describe separate communications:
  `relation=independent_assertions`.
- “The board issued a notice” and “The board issued a written notice on 4 March”
  can describe one occurrence. If supported, classify it as `same_assertion` and
  put “written” and “on 4 March” in the second statement's detail inventory.
- “Relationships were close” and “Relationships were supportive” retain distinct
  attributes, even when quoted from one sentence.
- “The applicant denied receiving the letter” and “The applicant received the
  letter” differ in proposition and polarity. Quotation overlap cannot merge them.
- “The operator said the supervisor approved the move” and “The supervisor
  approved the move,” attributed directly to the supervisor, require reporting-chain
  review before equivalence can be established.
- LEFT: “The reading score was 101”. RIGHT: “The reading score was 101,
  percentile 53, classified as average”. If the measure, occasion and reporter
  agree and the details are supported, use `same_assertion`, empty `leftOnlyDetails`,
  and `rightOnlyDetails=["percentile 53", "classified as average"]`.
  If the statements are reversed, reverse the inventories. Code selects the
  richer permitted statement; do not make that second decision yourself.
- Two statements both saying “The child became frustrated” can be paraphrases
  even if one citation also includes “and left the room.” That extra quotation
  text does not turn the extracted assertion into an assertion about leaving.
- “Some students perform evenly across subjects” and “Some perform evenly, while
  most have varied strengths” contain different atomic population assertions.
- When only RIGHT says “all results were average”, include those exact words in
  `rightOnlyDetails`. An absence of clinical elevations in LEFT does not itself
  preserve this positive classification. Do not erase the inventory because the
  records share an instrument or quotation.
- “The worker attended the safety course” and “The worker attended the safety
  course and passed the examination” have `relation=independent_assertions`.
  Attendance and examination outcome remain separate atomic assertions even
  though one sentence contains both.
- Two copies of an unnamed doctor's conclusion labeled `Unknown doctor` and
  `The doctor` can be the same assertion when they cite the same occurrence.
  Neither label establishes a named doctor.
- "Casey was described as a five-year-old boy" and "Casey Morgan is five years
  old" describe the same age observation when the shared source establishes
  Casey's full identity and explicitly calls him a five-year-old boy. Keep `boy`
  in the first inventory, with `kind=participant_description` and an exact quote
  including that descriptor. The richer original statement survives and full-name
  metadata is preserved. A name match cannot establish an omitted descriptor by
  itself. Different ages, contradictory descriptors, or another independent
  observation do not become duplicates through identity resolution alone.
- "Casey was evaluated by a doctor" and "Casey was evaluated by a doctor; the
  date of the evaluation is unstated" are equivalent when they identify the
  same undated occurrence. The absent date is not a separate assertion and does
  not belong in OnlyDetails. A date or resolved timing in either record requires
  checking that information instead. "Whether Casey was evaluated is unknown"
  changes occurrence certainty and must remain separate from an asserted evaluation.
- In “Elliot's birth was an emergency C-section when his mother went into shock,”
  `his mother` and `Elliot's mother` refer to the same cited participant. A
  passage with multiple plausible antecedents requires further resolution.
- The same examiner's `observer` and `provider` annotations may describe one
  evaluation. Preserve both supported roles and their citations after review.
- “Pregnancy was reported with no complications” and “Pregnancy was reported
  to have had no complications” assert the same negative finding. An erroneous
  `denies` tag alone does not change it. “The patient denied complications”
  records an act of denial and must not automatically replace the finding.
