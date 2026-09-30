// Structured output for the Analyst, in the OpenAPI subset Gemini accepts. The editorial
// contract used to travel as prose only ("return JSON with selected and
// interaction_candidates"), so the model was free to omit top_four_semantics and the stage
// had no way to ask for a shape the API had never been told about. The schema is the
// contract: the selection of measurements, the semantic findings the model discovered, the
// challenges it picked and the Top 4 semantics, exactly as declared.
import {SEMANTIC_TYPES} from './semantic-findings.js';

const evidenceRefs = () => ({type: 'ARRAY', items: {type: 'OBJECT', properties: {
  source_type: {type: 'STRING'}, source_id: {type: 'STRING'}, focus_text: {type: 'STRING'}}}});

const topFourSemantics = () => ({type: 'ARRAY', items: {type: 'OBJECT', required: ['film_key', 'ingredients'], properties: {
  film_key: {type: 'STRING'},
  ingredients: {type: 'ARRAY', items: {type: 'STRING'}}}}});

const selectedMeasurements = () => ({type: 'ARRAY', items: {type: 'OBJECT', required: ['id', 'observation'], properties: {
  id: {type: 'STRING'}, type: {type: 'STRING'}, interestingness: {type: 'NUMBER'}, confidence: {type: 'NUMBER'},
  observation: {type: 'STRING'}, why_interesting: {type: 'STRING'}, cultural_angle: {type: 'STRING'},
  evidence_refs: evidenceRefs(),
  film_keys: {type: 'ARRAY', items: {type: 'STRING'}},
  related_tags: {type: 'ARRAY', items: {type: 'STRING'}},
  related_lists: {type: 'ARRAY', items: {type: 'STRING'}}}}});

const interactionCandidates = () => ({type: 'ARRAY', items: {type: 'OBJECT', required: ['id', 'type', 'film_keys', 'difficulty'], properties: {
  id: {type: 'STRING'}, type: {type: 'STRING', enum: ['forced_triage', 'blind_rank', 'defend_your_take']},
  film_keys: {type: 'ARRAY', items: {type: 'STRING'}}, difficulty: {type: 'NUMBER'},
  from_pool: {type: 'STRING'},
  why_difficult: {type: 'STRING'}, why_interesting: {type: 'STRING'}, evidence_refs: evidenceRefs()}}});

// A semantic finding is the Analyst's own reading: two to four existing evidence ids related by a
// contrast, a pattern, an exception, an asymmetry, a habit or a callback. The backend resolves
// every reference and rejects the finding when one of them does not exist.
const semanticFindings = () => ({type: 'ARRAY', items: {type: 'OBJECT',
  required: ['id', 'type', 'observation', 'why_interesting', 'evidence_refs'], properties: {
    id: {type: 'STRING'}, type: {type: 'STRING', enum: SEMANTIC_TYPES},
    observation: {type: 'STRING'}, why_interesting: {type: 'STRING'}, cultural_angle: {type: 'STRING'},
    interestingness: {type: 'NUMBER'}, confidence: {type: 'NUMBER'}, evidence_refs: evidenceRefs()}}});

export const ANALYST_SCHEMA = {type: 'OBJECT', required: ['selected', 'semantic_findings', 'interaction_candidates', 'top_four_semantics'], properties: {
  selected: selectedMeasurements(),
  semantic_findings: semanticFindings(),
  interaction_candidates: interactionCandidates(),
  top_four_semantics: topFourSemantics()
}};

// The targeted repairs ask for one part only, so a missing contract never costs a full answer.
export const ANALYST_SEMANTICS_SCHEMA = {type: 'OBJECT', required: ['top_four_semantics'], properties: {
  top_four_semantics: topFourSemantics()
}};

export const ANALYST_FINDINGS_SCHEMA = {type: 'OBJECT', required: ['selected', 'semantic_findings', 'interaction_candidates'], properties: {
  selected: selectedMeasurements(),
  semantic_findings: semanticFindings(),
  interaction_candidates: interactionCandidates()
}};

export const ANALYST_GAMES_SCHEMA = {type: 'OBJECT', required: ['interaction_candidates'], properties: {
  interaction_candidates: interactionCandidates()
}};
