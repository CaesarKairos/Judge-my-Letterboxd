// Structured output for the Analyst, in the OpenAPI subset Gemini accepts. The editorial
// contract used to travel as prose only ("return JSON with selected and
// interaction_candidates"), so the model was free to omit top_four_semantics and the stage
// had no way to ask for a shape the API had never been told about. The schema is the
// contract: selected, interaction_candidates and top_four_semantics, exactly as declared.
const evidenceRefs = () => ({type: 'ARRAY', items: {type: 'OBJECT', properties: {
  source_type: {type: 'STRING'}, source_id: {type: 'STRING'}, focus_text: {type: 'STRING'}}}});

const topFourSemantics = () => ({type: 'ARRAY', items: {type: 'OBJECT', required: ['film_key', 'ingredients'], properties: {
  film_key: {type: 'STRING'},
  ingredients: {type: 'ARRAY', items: {type: 'STRING'}}}}});

export const ANALYST_SCHEMA = {type: 'OBJECT', required: ['selected', 'interaction_candidates', 'top_four_semantics'], properties: {
  selected: {type: 'ARRAY', items: {type: 'OBJECT', required: ['id', 'observation'], properties: {
    id: {type: 'STRING'}, type: {type: 'STRING'}, interestingness: {type: 'NUMBER'}, confidence: {type: 'NUMBER'},
    observation: {type: 'STRING'}, why_interesting: {type: 'STRING'}, cultural_angle: {type: 'STRING'},
    evidence_refs: evidenceRefs(),
    film_keys: {type: 'ARRAY', items: {type: 'STRING'}},
    related_tags: {type: 'ARRAY', items: {type: 'STRING'}},
    related_lists: {type: 'ARRAY', items: {type: 'STRING'}}}}},
  interaction_candidates: {type: 'ARRAY', items: {type: 'OBJECT', required: ['id', 'type', 'film_keys', 'difficulty'], properties: {
    id: {type: 'STRING'}, type: {type: 'STRING', enum: ['forced_triage', 'blind_rank', 'defend_your_take']},
    film_keys: {type: 'ARRAY', items: {type: 'STRING'}}, difficulty: {type: 'NUMBER'},
    why_difficult: {type: 'STRING'}, why_interesting: {type: 'STRING'}, evidence_refs: evidenceRefs()}}},
  top_four_semantics: topFourSemantics()
}};

// The targeted repair asks for one array only, so a missing Top 4 never costs a full answer.
export const ANALYST_SEMANTICS_SCHEMA = {type: 'OBJECT', required: ['top_four_semantics'], properties: {
  top_four_semantics: topFourSemantics()
}};
