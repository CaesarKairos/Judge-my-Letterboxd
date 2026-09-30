// Semantic findings: the Analyst's own grammar.
//
// Deterministic measurements are suggestions, evidence and statistics — they are not the only
// possible reading of an account. A semantic finding lets the Analyst relate real evidence that no
// candidate covered (a review plus a rating plus a list, for instance). The backend still decides
// everything that is a fact: every reference is resolved through the evidence registry, an
// unknown id rejects the finding, and the numbers the user sees come from the export.
import {relationId} from './evidence-registry.js';

export const SEMANTIC_TYPES = ['semantic_contrast', 'semantic_pattern', 'semantic_exception',
  'semantic_asymmetry', 'semantic_habit', 'semantic_callback'];
// Semantic findings add depth, never padding: a session with four of them and no measurement has
// lost the deterministic grounding that makes the rest of the script readable.
export const MAX_SEMANTIC_FINDINGS = 4;
export const MIN_SEMANTIC_REFS = 2;
const MAX_REVIEW_CHARS = 1200;
const MAX_EVENTS = 4;

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const round2 = value => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : value);
const stat = (key, label, value) => ({key, label, value});

const eventFilms = films => (films.length === 1 ? [{type: 'film', film: films[0]}]
  : films.length === 2 ? [{type: 'film_pair', films}]
  : films.length > 2 ? [{type: 'film_group', films: films.slice(0, 4)}] : []);

function relationshipEvent(relation, registry) {
  const films = (relation.films || []).map(key => registry.get('film', key)?.evidence.film).filter(Boolean);
  if (relation.type === 'tag_list') return {type: 'tag_list_relationship',
    tag: {name: relation.tag}, list: {name: relation.list, description: ''},
    intersection: relation.intersection, list_count: relation.list_count, tag_count: relation.tag_count,
    coverage: relation.coverage, lift: relation.lift, shared_films: films,
    exceptions: {list_without_tag: relation.list_without_tag || [], tag_without_list: relation.tag_without_list || []}};
  if (relation.type === 'tag_tag') return {type: 'tag_tag_relationship', left: {name: relation.left}, right: {name: relation.right},
    intersection: relation.intersection, lift: relation.lift, shared_films: films};
  if (relation.type === 'list_list') return {type: 'list_list_relationship', left: {name: relation.left}, right: {name: relation.right},
    intersection: relation.intersection, lift: relation.lift, shared_films: films};
  if (relation.type === 'tag_rating') return {type: 'stat', stats: [stat('average_rating', `média de ${relation.tag}`, round2(relation.average_rating)), stat('tagged', 'filmes com a tag', relation.count)]};
  if (relation.type === 'tag_rewatch') return {type: 'stat', stats: [stat('rewatched', 'reassistidos', relation.rewatched_count), stat('tagged', 'filmes com a tag', relation.tag_count)]};
  if (relation.type === 'list_rating') return {type: 'stat', stats: [stat('average_rating', `média de ${relation.list}`, round2(relation.average_rating)), stat('members', 'filmes na lista', relation.count)]};
  if (relation.type === 'list_rewatch') return {type: 'stat', stats: [stat('rewatched', 'reassistidos', relation.rewatched_count), stat('members', 'filmes na lista', relation.list_count)]};
  if (relation.type === 'watchlist_watched') return {type: 'stat', stats: [stat('watchlist', 'na watchlist', relation.watchlist_count), stat('watched', 'assistidos', relation.watched_count)]};
  return null;
}

// The events are built from resolved evidence only: this is what the chat will show, and it is
// the same vocabulary the deterministic moments already use.
function eventsFor(resolved, registry) {
  const events = [];
  const films = [...new Map(resolved.filter(row => row.evidence.film).map(row => [row.evidence.film.film_key, row.evidence.film])).values()].slice(0, 4);
  events.push(...eventFilms(films));
  const review = resolved.find(row => row.evidence.review)?.evidence.review;
  if (review) events.push({type: 'review_quote', film_key: review.film_key, title: review.title, year: review.year,
    rating: review.rating ?? null, text: String(review.text || '').slice(0, MAX_REVIEW_CHARS), segments: review.segments || []});
  const list = resolved.find(row => row.evidence.list)?.evidence.list;
  if (list) events.push({type: 'list', name: list.name, description: list.description || '', films: (list.films || []).slice(0, 4), count: list.count,
    stats: [stat('films', 'filmes na lista', list.count)]});
  const tag = resolved.find(row => row.evidence.tag)?.evidence.tag;
  if (tag) events.push({type: 'tag', tag: tag.name, related_tag: '', films: (tag.films || []).slice(0, 4),
    stats: [stat('tagged', 'sessões com a tag', tag.count)]});
  for (const row of resolved) {
    if (row.evidence.relationship) { const event = relationshipEvent(row.evidence.relationship, registry); if (event) events.push(event); }
    else if (row.evidence.rewatch) {
      const {film_key, sessions, review_id} = row.evidence.rewatch;
      events.push({type: 'rewatch', film: registry.get('film', film_key)?.evidence.film || null,
        sessions: sessions.map(({date, rating, index}) => ({date, rating, index})),
        stats: [stat('sessions', 'sessões', sessions.length), ...(review_id ? [stat('review', 'review', review_id)] : [])]});
    } else if (row.evidence.measurement) {
      const moment = row.evidence.measurement;
      if (Array.isArray(moment.stats) && moment.stats.length) events.push({type: 'stat', stats: moment.stats});
    }
  }
  return events.filter(event => event && (event.type !== 'film_group' || event.films.length)).slice(0, MAX_EVENTS);
}

// The factual line the Writer reads. It is assembled from resolved evidence, so a rating, a date or
// a count can never arrive from the model's prose.
function factsFor(type, resolved) {
  const parts = [];
  const films = [...new Map(resolved.filter(row => row.evidence.film).map(row => [row.evidence.film.film_key, row.evidence.film])).values()];
  if (films.length) parts.push(films.map(row => `${row.title} (${row.rating ?? 'unrated'}/5)`).join(' vs '));
  const review = resolved.find(row => row.evidence.review)?.evidence.review;
  if (review) parts.push(`${review.review_id} on ${review.title}: ${review.rating ?? 'unrated'}/5, ${String(review.text || '').length} chars${review.tags?.length ? `, tags ${review.tags.join('|')}` : ''}`);
  const list = resolved.find(row => row.evidence.list)?.evidence.list;
  if (list) parts.push(`list ${list.name} with ${list.count} films`);
  const tag = resolved.find(row => row.evidence.tag)?.evidence.tag;
  if (tag) parts.push(`tag ${tag.name} on ${tag.count} sessions`);
  const rewatch = resolved.find(row => row.evidence.rewatch)?.evidence.rewatch;
  if (rewatch) parts.push(`${rewatch.sessions.length} sessions with ratings ${rewatch.sessions.map(row => row.rating ?? '?').join(' → ')}`);
  const relation = resolved.find(row => row.evidence.relationship)?.evidence.relationship;
  if (relation) parts.push(`relationship ${relation.id}${relation.intersection != null ? `: ${relation.intersection} shared films` : ''}`);
  const measurement = resolved.find(row => row.evidence.measurement)?.evidence.measurement;
  if (measurement) parts.push(`measurement ${measurement.id}: ${clean(measurement.facts)}`);
  if (!parts.length) {
    const overview = resolved.find(row => row.evidence.overview)?.evidence.overview;
    const temporal = resolved.find(row => row.evidence.temporal)?.evidence.temporal;
    if (overview) parts.push(`overview: ${overview.watched} films, ${overview.reviews} reviews, ${overview.rewatches} rewatches`);
    if (temporal?.span_days != null) parts.push(`span ${temporal.span_days} days across ${temporal.months_tracked} months`);
  }
  return `${type}: ${parts.join('; ')}`.slice(0, 420);
}

// One semantic finding is accepted only when every reference exists. A finding that cites a
// review, a film and a list the export really carries becomes a first-class moment: the Script
// Engine can rank it and the Writer can react to it exactly like a measurement.
export function normalizeSemanticFindings(rows = [], registry, {existingIds = new Set(), limit = MAX_SEMANTIC_FINDINGS} = {}) {
  const accepted = [], rejected = [], taken = new Set(existingIds), signatures = new Map();
  for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const declared = clean(row?.id) || `semantic_${String(index + 1).padStart(3, '0')}`;
    const id = taken.has(declared) ? `${declared}-${index + 1}` : declared;
    const reject = reason => rejected.push({id: declared, reason});
    const type = clean(row?.type).toLocaleLowerCase();
    if (!SEMANTIC_TYPES.includes(type)) { reject(`unknown_semantic_type:${type || 'missing'}`); continue; }
    const observation = clean(row?.observation), why = clean(row?.why_interesting);
    if (!observation) { reject('no_observation'); continue; }
    const refs = (Array.isArray(row?.evidence_refs) ? row.evidence_refs : []).map(ref => ({source_type: clean(ref?.source_type).toLocaleLowerCase(), source_id: clean(ref?.source_id), focus_text: clean(ref?.focus_text)}));
    if (refs.length < MIN_SEMANTIC_REFS) { reject(`needs_${MIN_SEMANTIC_REFS}_evidence_refs`); continue; }
    const {ok, missing} = registry.resolve(refs);
    if (missing.length) { reject(`unknown_evidence:${missing.map(ref => `${ref.source_type}:${ref.source_id}`).join(',')}`); continue; }
    const signature = ok.map(entry => `${entry.source_type}:${entry.source_id}`).sort().join('|');
    if (signatures.has(signature)) { reject(`duplicate_evidence:${signatures.get(signature)}`); continue; }
    if (accepted.length >= limit) { reject('semantic_limit'); continue; }
    const films = [...new Map(ok.filter(entry => entry.evidence.film).map(entry => [entry.evidence.film.film_key, entry.evidence.film])).values()];
    const review = ok.find(entry => entry.evidence.review)?.evidence.review || null;
    const list = ok.find(entry => entry.evidence.list)?.evidence.list || null;
    const tag = ok.find(entry => entry.evidence.tag)?.evidence.tag || null;
    const events = eventsFor(ok, registry);
    if (!events.length) { reject('evidence_has_nothing_to_show'); continue; }
    taken.add(id);
    signatures.set(signature, id);
    accepted.push({
      id, type, editorial_type: type, semantic: true,
      observation, why_interesting: why, cultural_angle: clean(row?.cultural_angle),
      interestingness: Number.isFinite(Number(row?.interestingness)) ? Number(row.interestingness) : .7,
      confidence: Number.isFinite(Number(row?.confidence)) ? Number(row.confidence) : .75,
      evidence_refs: refs,
      resolved_evidence: ok.map(entry => ({source_type: entry.source_type, source_id: entry.source_id, label: entry.label, excerpt: entry.excerpt})),
      films, review, list, tag, events, facts: factsFor(type, ok),
      information_value: {semantic: true, evidence_count: ok.length}
    });
  }
  return {accepted, rejected, limit};
}
