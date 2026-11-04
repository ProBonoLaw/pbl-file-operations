// Synthetic analogues of seven source-inspected development failures. Keep
// personal source documents and identifying details out of committed fixtures.
export const atomicityCases = [
  {name:"separate coping actions",kind:"opinion",atomic:"The clinician says parents should practice relaxation with Casey and remind Casey of the techniques.",
    compound:"Parents should practice relaxation with Casey, remind Casey of the techniques, verbalize understanding of Casey's feelings, and convey confidence in Casey's coping ability.",
    additions:["verbalize understanding of Casey's feelings","convey confidence in Casey's coping ability"]},
  {name:"separate reading interventions",kind:"opinion",atomic:"Casey should continue reading interventions, including individual reading support.",
    compound:"The clinician recommends continuing reading interventions for Casey, including individual reading support, after-school tutoring, parent reading, and self-reading.",
    additions:["after-school tutoring","parent reading","self-reading"]},
  {name:"separate cognitive capabilities",kind:"opinion",atomic:"High verbal scores indicate a strong ability to solve verbal problems.",
    compound:"High verbal scores indicate good word knowledge, effective information retrieval, a strong ability to solve verbal problems, and effective communication.",
    additions:["good word knowledge","effective information retrieval","effective communication"]},
  {name:"social functioning and disorder",kind:"opinion",atomic:"Casey's scores suggest no pervasive developmental disorder.",
    compound:"Casey's scores suggest adequate social skills with no pervasive developmental disorder.",additions:["adequate social skills"]},
  {name:"different score systems",kind:"attribute",atomic:"Instrument A scaled scores have a mean of 10.",
    compound:"Instrument A standard scores have a mean of 100 and scaled scores have a mean of 10.",additions:["standard scores have a mean of 100 and"]},
  {name:"instrument purpose and composition",kind:"attribute",atomic:"Instrument A provides a functional appraisal of social skills and problem behaviors.",
    compound:"Instrument A provides a functional appraisal of social skills and problem behaviors and contains five subscales: cooperation, interaction, independence, externalizing and internalizing.",
    additions:["contains five subscales: cooperation, interaction, independence, externalizing and internalizing"]},
  {name:"different scale interpretations",kind:"attribute",atomic:"Higher Instrument A Social Skills scores indicate greater social adjustment.",
    compound:"For Instrument A, higher Social Skills scores indicate greater social adjustment, and higher Problem Behavior scores indicate greater problem behavior.",
    additions:["higher Problem Behavior scores indicate greater problem behavior"]},
] as const;
