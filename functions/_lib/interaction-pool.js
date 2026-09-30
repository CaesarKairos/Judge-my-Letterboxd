// The deterministic game pool.
//
// Games used to depend on the Analyst remembering to invent a trio, so a session could end with
// zero challenges. This module creates OPPORTUNITIES from measured behaviour — it never writes a
// joke, a question or a punchline: the Writer owns the copy. A pool candidate only says "these
// films form a hard choice for this account, and here is why".
import {userAffinityScore} from './letterboxd.js';

export const GAME_MIN_DIFFICULTY = .68;
// Below this the account cannot sustain a real blind choice: three relevant films with close
// ratings and a comparable place in the library. A tiny account keeps 0 or 1 game.
export const GAME_MIN_RATED_FILMS = 6;
export const GAME_POOL_LIMIT = 12;
export const GAME_MAX_SELECTED = 2;
export const GAME_TYPES = ['forced_triage', 'blind_rank', 'defend_your_take'];
// How many films the combinatorial search looks at: C(24,3) is 2,024 trios, and the films that
// matter are the ones the account keeps close anyway.
const SEARCH_WIDTH = 24;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round2 = value => Math.round(value * 100) / 100;
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const titles = trio => trio.map(entry => entry.film.title).join(', ');
const ratings = trio => trio.map(entry => entry.film.rating).join('/');
const marks = entry => [entry.attachment.favorite ? 'favorite' : '', entry.attachment.rewatch ? 'rewatched' : '',
  entry.attachment.reviews ? 'review' : '', entry.attachment.lists ? 'list' : ''].filter(Boolean);

// Attachment is measured, never inferred: a film the account favorited, logged more than once,
// wrote about or filed into a list is a film the choice actually hurts.
export function filmAttachment(film, profile = {}) {
  const sessions = (profile.sessions || []).filter(row => row.film_key === film.film_key);
  const reviews = (profile.reviews || []).filter(row => row.film_key === film.film_key);
  const lists = (profile.lists || []).filter(list => (list.films || []).some(row => row.film_key === film.film_key));
  const favorite = (profile.topFour || []).some(row => row.film_key === film.film_key);
  const tags = [...new Set(sessions.flatMap(row => row.tags || []))].filter(Boolean);
  const signals = (favorite ? 1 : 0) + (sessions.length > 1 ? 1 : 0) + (reviews.length ? 1 : 0) + (lists.length ? 1 : 0);
  return {film_key: film.film_key, favorite, sessions: sessions.length, rewatch: sessions.length > 1,
    reviews: reviews.length, lists: lists.length, tags, signals};
}

function affinityMap(analysis = {}) {
  const map = new Map();
  for (const row of analysis.affinity || []) if (row?.film_key) map.set(row.film_key, Number(row.user_affinity_score) || 0);
  return map;
}

function trios(rows) {
  const out = [];
  for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) for (let c = b + 1; c < rows.length; c++) out.push([rows[a], rows[b], rows[c]]);
  return out;
}

// Shared cultural/semantic ground: two of the three films carrying the same tag or the same list
// makes the comparison mean something instead of just pairing three scores.
function sharedContext(entries) {
  const tags = new Map(), lists = new Map();
  for (const entry of entries) {
    for (const tag of entry.attachment.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
    for (const list of entry.lists) lists.set(list, (lists.get(list) || 0) + 1);
  }
  const repeated = [...tags.values(), ...lists.values()].filter(count => count >= 2);
  return {shared: repeated.length, tags: [...tags].filter(([, count]) => count >= 2).map(([tag]) => tag),
    lists: [...lists].filter(([, count]) => count >= 2).map(([name]) => name)};
}

function buildFilms(profile, analysis) {
  const affinities = affinityMap(analysis);
  return (profile.films || [])
    .filter(film => Number.isFinite(film?.rating))
    .map(film => ({
      film,
      affinity: Number.isFinite(affinities.get(film.film_key)) ? affinities.get(film.film_key) : userAffinityScore(film, profile),
      attachment: filmAttachment(film, profile),
      lists: (profile.lists || []).filter(list => (list.films || []).some(row => row.film_key === film.film_key)).map(list => list.name)
    }))
    .sort((a, b) => b.affinity - a.affinity || b.attachment.signals - a.attachment.signals || a.film.title.localeCompare(b.film.title))
    .slice(0, SEARCH_WIDTH);
}

// forced_triage: a trio where every film deserves to stay. A 5 / 3 / 0.5 trio has an obvious
// discard, so it never enters; close ratings, high affinity and attachment signals make it hard.
function forcedTriage(rows) {
  const out = [];
  for (const trio of trios(rows)) {
    const spread = Math.max(...trio.map(entry => entry.film.rating)) - Math.min(...trio.map(entry => entry.film.rating));
    if (spread > 1.5) continue;
    const affinities = trio.map(entry => entry.affinity);
    if (Math.min(...affinities) < .5) continue;
    if (trio.filter(entry => entry.attachment.signals > 0).length < 2) continue;
    const context = sharedContext(trio);
    const difficulty = clamp(.62 + (1.5 - spread) / 1.5 * .18 + (Math.min(...affinities) - .5) * .3 + Math.min(.06, context.shared * .03), .55, .96);
    if (difficulty < GAME_MIN_DIFFICULTY) continue;
    out.push({type: 'forced_triage', trio, spread, context, difficulty,
      why_difficult: `ratings ${ratings(trio)} with only ${round2(spread)} spread and no obvious discard`,
      why_interesting: `${trio.map(entry => `${entry.film.title} (${marks(entry).join('/') || 'rated'})`).join(' vs ')}${context.shared ? `; ${context.shared} shared tag/list link` : ''}`});
  }
  return out.sort((a, b) => b.difficulty - a.difficulty);
}

// blind_rank: three films the account would have to place again without seeing the scores, so the
// ratings have to be genuinely close and the affinity comparable.
function blindRank(rows) {
  const out = [];
  for (const trio of trios(rows)) {
    const spread = Math.max(...trio.map(entry => entry.film.rating)) - Math.min(...trio.map(entry => entry.film.rating));
    if (spread > 1) continue;
    const affinities = trio.map(entry => entry.affinity), affinitySpread = Math.max(...affinities) - Math.min(...affinities);
    if (affinitySpread > .25 || Math.min(...affinities) < .5) continue;
    const context = sharedContext(trio);
    const difficulty = clamp(.6 + (1 - spread) * .14 + (.25 - affinitySpread) / .25 * .1 + Math.min(.08, context.shared * .04), .55, .96);
    if (difficulty < GAME_MIN_DIFFICULTY) continue;
    out.push({type: 'blind_rank', trio, spread, affinitySpread, context, difficulty,
      why_difficult: `ratings ${ratings(trio)} inside a ${round2(spread)} spread with affinity ${round2(affinitySpread)} apart`,
      why_interesting: `${titles(trio)} would have to be ranked again without the scores`});
  }
  return out.sort((a, b) => b.difficulty - a.difficulty);
}

// A defense only exists when the account's own score really departs from its own middle ground and
// there is something written or logged to defend. The public average is context the Writer may
// receive later from TMDb; it is never an authority and never required to create the game.
function defendTakes(rows, profile) {
  const rated = (profile.films || []).filter(film => Number.isFinite(film?.rating));
  if (rated.length < 8) return [];
  const mean = rated.reduce((sum, film) => sum + film.rating, 0) / rated.length;
  const out = [];
  for (const entry of rows) {
    const delta = entry.film.rating - mean;
    if (Math.abs(delta) < 1) continue;
    if (!(entry.film.rating >= 4.5 || entry.film.rating <= 1.5)) continue;
    if (!entry.attachment.reviews && !entry.attachment.sessions) continue;
    const difficulty = clamp(.7 + Math.abs(delta) / 4 * .2 + (entry.attachment.reviews ? .04 : 0), .7, .95);
    out.push({type: 'defend_your_take', trio: [entry], mean, delta, difficulty,
      why_difficult: `${entry.film.rating}/5 against the account's own mean of ${round2(mean)}`,
      why_interesting: `${entry.film.title}${entry.attachment.reviews ? ' carries a written review' : ' was logged'} while sitting ${round2(delta)} away from the account's middle ground`});
  }
  return out.sort((a, b) => b.difficulty - a.difficulty);
}

const materialize = (candidate, id) => ({
  id,
  type: candidate.type,
  film_keys: candidate.trio.map(entry => entry.film.film_key),
  difficulty: round2(candidate.difficulty),
  why_difficult: clean(candidate.why_difficult),
  why_interesting: clean(candidate.why_interesting),
  evidence_refs: candidate.trio.map(entry => ({source_type: 'film', source_id: entry.film.film_key, focus_text: ''})),
  origin: 'pool'
});

// The pool is deterministic and typed: the Analyst selects from it, and the Script Engine can
// always fall back to its best entries without ever writing the copy itself.
export function buildInteractionPool(profile = {}, analysis = {}, {limit = GAME_POOL_LIMIT} = {}) {
  const rated = (profile.films || []).filter(film => Number.isFinite(film?.rating));
  if (rated.length < GAME_MIN_RATED_FILMS) return [];
  const rows = buildFilms(profile, analysis);
  if (rows.length < 3) return [];
  const pool = [], used = new Set();
  const add = candidates => {
    for (const candidate of candidates) {
      if (pool.length >= limit) return;
      const keys = candidate.trio.map(entry => entry.film.film_key).join('|');
      if (used.has(keys)) continue;
      used.add(keys);
      pool.push(materialize(candidate, `pool-${candidate.type}-${pool.length + 1}`));
    }
  };
  add(forcedTriage(rows).slice(0, 5));
  add(blindRank(rows).slice(0, 4));
  add(defendTakes(rows, profile).slice(0, 3));
  return pool;
}

export function poolGames(pool = [], {minimum = GAME_MAX_SELECTED} = {}) {
  return [...(pool || [])].filter(row => GAME_TYPES.includes(row?.type) && Number(row?.difficulty) >= GAME_MIN_DIFFICULTY)
    .sort((a, b) => b.difficulty - a.difficulty).slice(0, minimum);
}
