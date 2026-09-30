// The single representation the Analyst receives. It exists so the payload is never assembled
// ad hoc inside analyst.js: every field below is either normalized evidence or an explicitly
// non-normalized field that no other section carries.
//
// Duplication audit of the previous payload (real export, 106 films / 103 reviews):
//   raw_export .......... 171,793 chars, repeating watched/ratings/diary/reviews/lists tables
//   ratings projection ... 11,000 chars, a subset of films that already carry `rating`
//   tags ................ 4,945 chars, the same tag_films already inside `relationships`
//   review segments ...... 73,747 chars, the same words as `text` plus a type per part
// Those copies are gone; the substantive information stays. Nothing is truncated silently:
// reviews keep their whole text, and only the redundant projection is dropped.
import {relationId} from './evidence-registry.js';

const NORMALIZED_TABLES = new Set(['profile.csv', 'watched.csv', 'ratings.csv', 'diary.csv', 'reviews.csv']);
const LIST_TABLE = /^lists\/[^/]+\.csv$/i;
const key = (title, year) => `${String(title || '').trim()} ${String(year || '').trim()}`.toLocaleLowerCase();

// Files whose rows exist nowhere else keep their content: watchlist, comments and likes are
// counts in the normalized profile, and dropping them would lose which films and reviews.
// Files the normalized sections already carry lose only their bytes, never their meaning.
export function buildExportInventory(raw_export) {
  const files = [], unnormalized = {};
  for (const [path, rows] of Object.entries(raw_export?.files || {})) {
    files.push({ path, rows: rows.length, fields: Object.keys(rows[0] || {}) });
    if (!NORMALIZED_TABLES.has(path.toLowerCase()) && !LIST_TABLE.test(path)) unnormalized[path] = rows;
  }
  return { file_count: raw_export?.file_count ?? files.length, files, unnormalized_files: unnormalized, unknown_files: raw_export?.unknown_files || [] };
}

// `segments` repeats the whole review word by word to describe markup. The distinct part
// types keep that information at a fraction of the cost.
const markupOf = review => [...new Set((review.segments || []).map(segment => segment.type))];
const compactReview = review => ({ review_id: review.review_id, film_key: review.film_key, title: review.title, year: review.year,
  rating: review.rating ?? null, date: review.date, tags: review.tags || [], markup: markupOf(review), text: review.text || '' });

// watched.csv and ratings.csv carry the only per-film dates in the export; the normalized
// film registry keeps the current rating, so those two fields are preserved explicitly.
function libraryLog(raw_export, films) {
  const index = new Map(films.map(film => [key(film.title, film.year), film.film_key]));
  const log = new Map();
  for (const [table, field] of [['watched.csv', 'logged'], ['ratings.csv', 'rated']]) {
    for (const row of raw_export?.files?.[table] || []) {
      const film_key = index.get(key(row.Name, row.Year));
      if (film_key) log.set(film_key, { ...(log.get(film_key) || {}), film_key, [field]: row.Date || '' });
    }
  }
  return [...log.values()];
}

// The Analyst prompt promises rewatches enriched with sessions; the summary below is a
// projection of the diary, never new evidence invented by the backend.
function rewatchDigest(profile) {
  const rows = new Map();
  for (const session of profile.sessions || []) {
    if (!session.rewatch) continue;
    const entry = rows.get(session.film_key) || { film_key: session.film_key, title: session.title, sessions: [], tags: session.tags || [] };
    entry.sessions.push({ date: session.date, rating: session.rating ?? null, index: session.index });
    rows.set(session.film_key, entry);
  }
  for (const entry of rows.values()) {
    const review = (profile.reviews || []).find(row => row.film_key === entry.film_key);
    if (review) entry.review_id = review.review_id;
  }
  return [...rows.values()];
}

// Relations travel with their stable id: a semantic finding cites `relationship` + that id, and
// the backend resolves it against the same list.
const relationshipProjection = relationships => (relationships?.relations || []).map(relation => ({id: relationId(relation), ...relation}));

export function buildAnalystContext({ profile = {}, analysis = {}, raw_export = {}, interaction_pool = [] }) {
  const films = (profile.films || []).map(film => ({ film_key: film.film_key, title: film.title, year: film.year, rating: film.rating ?? null }));
  return {
    account: { username: profile.handle || '', display_name: profile.name || '', top_four: profile.topFour || [], top_four_expected: (profile.topFour || []).length },
    overview: analysis.overview || {},
    measurements: analysis.measurements || {},
    temporal: analysis.temporal || {},
    export_inventory: buildExportInventory(raw_export),
    films,
    library_log: libraryLog(raw_export, films),
    sessions: profile.sessions || [],
    reviews: (profile.reviews || []).map(compactReview),
    lists: profile.lists || [],
    watchlist: { count: profile.watchlist || 0, added: (raw_export?.files?.['watchlist.csv'] || []).map(row => ({ title: row.Name, year: row.Year, date: row.Date })) },
    likes: profile.likes || {},
    rewatches: rewatchDigest(profile),
    review_style: analysis.review_style || null,
    review_coverage: analysis.review_coverage || {},
    relationships: {...(analysis.relationships || {}), relations: relationshipProjection(analysis.relationships)},
    affinity: analysis.affinity || [],
    // The pool already contains the hard choices the account can support: the Analyst selects from
    // it instead of having to invent every game, and it may still propose another trio.
    interaction_pool: (interaction_pool || []).map(game => ({id: game.id, type: game.type, film_keys: game.film_keys,
      difficulty: game.difficulty, why_difficult: game.why_difficult, why_interesting: game.why_interesting})),
    deterministic_measurements: (analysis.moments || []).map(moment => ({ id: moment.id, type: moment.type, facts: moment.facts,
      information_value: moment.information_value || moment.relationship || null }))
  };
}

// One log line that answers "what did the Analyst actually read?" without printing the payload.
export function summarizeAnalystContext(context) {
  return { chars: JSON.stringify(context).length, films: context.films.length, sessions: context.sessions.length,
    reviews: context.reviews.length, relationships: context.relationships?.relations?.length || 0,
    candidate_measurements: context.deterministic_measurements.length, interaction_pool: context.interaction_pool.length,
    unnormalized_files: Object.keys(context.export_inventory.unnormalized_files) };
}

