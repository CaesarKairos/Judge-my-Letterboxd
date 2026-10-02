// The Freeform reference layer: the ONLY place where a model reference becomes a real identity.
//
// Two namespaces live side by side on purpose:
//   - EVIDENCE REFS are physical pointers inside the upload (reviews.csv#row:42, ratings.csv#table);
//   - ENTITY IDS are canonical identities derived from the export (film:cars|2006, tag:x, list:y).
// The model is allowed to confuse them. Resolution here is mechanical — it decides identity, never
// editorial interest — so a reference written in the wrong namespace becomes the right pointer
// instead of discarding a good answer. Grounding is untouched: an id that resolves to nothing is
// still nothing, it never becomes an invented fact.

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

// Canonical physical pointer for a film entity: the richest row that mentions it wins, so evidence
// the frontend can actually show (a review) beats a bare rating whenever both exist.
const FILM_REF_PRIORITY = ['reviews.csv', 'ratings.csv', 'diary.csv', 'watched.csv', 'watchlist.csv', 'likes/films.csv'];
const filmCanonicalRef = film => {
  const refs = film?.source_refs || [];
  for (const path of FILM_REF_PRIORITY) { const hit = refs.find(ref => String(ref).toLowerCase().startsWith(path)); if (hit) return hit; }
  return refs[0] || null;
};

export function buildFreeformRegistry(archive = {}) {
  const entities = archive.entities || {};
  const films = entities.films || {}, reviews = entities.reviews || {}, sessions = entities.sessions || {},
    lists = entities.lists || {}, tags = entities.tags || {};

  const byRef = new Map();
  for (const file of archive.files || []) {
    if (file.ref) byRef.set(clean(file.ref), { kind: 'file', path: file.path });
    for (const row of file.rows || []) byRef.set(clean(row.ref), { kind: 'row', path: file.path, row });
  }

  // name → id maps so a model that wrote a title, a URI or a tag name instead of the id is resolved.
  const filmByTitle = new Map(), filmByUri = new Map();
  for (const film of Object.values(films)) {
    const title = clean(film.title).toLowerCase(), year = clean(film.year);
    if (title && !filmByTitle.has(`${title}|${year}`)) filmByTitle.set(`${title}|${year}`, film);
    if (title && !filmByTitle.has(title)) filmByTitle.set(title, film);
    if (film.uri && !filmByUri.has(clean(film.uri).replace(/\/$/, ''))) filmByUri.set(clean(film.uri).replace(/\/$/, ''), film);
  }
  const tagByName = new Map();
  for (const tag of Object.values(tags)) { const name = clean(tag.name).toLowerCase(); if (name && !tagByName.has(name)) tagByName.set(name, tag); }
  const listByName = new Map();
  for (const list of Object.values(lists)) { const name = clean(list.name).toLowerCase(); if (name && !listByName.has(name)) listByName.set(name, list); }

  const canonical = entity => {
    if (!entity) return null;
    if (entity.film_id) return filmCanonicalRef(entity);
    if (entity.session_ref) return entity.session_ref;
    if (entity.list_id) return entity.ref || (entity.source_refs || [])[0] || null;
    if (entity.tag_id) return (entity.source_refs || [])[0] || null;
    return null;
  };

  const filmIdFor = value => {
    const token = clean(value); if (!token) return null;
    if (films[token]) return token;
    const lower = token.toLowerCase();
    if (filmByTitle.has(lower)) return filmByTitle.get(lower).film_id;
    const uri = token.replace(/\/$/, '');
    if (filmByUri.has(uri)) return filmByUri.get(uri).film_id;
    const match = /^(.+?)\|(\d*)$/.exec(token);
    if (match && filmByTitle.has(`${match[1].toLowerCase()}|${match[2]}`)) return filmByTitle.get(`${match[1].toLowerCase()}|${match[2]}`).film_id;
    return null;
  };
  const tagIdFor = value => tags[clean(value)] ? clean(value) : (tagByName.get(clean(value).toLowerCase())?.tag_id || null);
  const listIdFor = value => lists[clean(value)] ? clean(value) : (listByName.get(clean(value).toLowerCase())?.list_id || null);

  // A ref is an archive pointer, a film/tag/list/session/review entity id — or nothing.
  const resolve = value => {
    const token = clean(value); if (!token) return null;
    if (byRef.has(token)) return {namespace: 'archive', canonical: token, ...byRef.get(token)};
    if (films[token]) return {namespace: 'film', canonical: canonical(films[token]), entity: films[token]};
    if (reviews[token]) return {namespace: 'review', canonical: token, entity: reviews[token]};
    if (sessions[token]) return {namespace: 'session', canonical: token, entity: sessions[token]};
    if (lists[token]) return {namespace: 'list', canonical: canonical(lists[token]), entity: lists[token]};
    if (tags[token]) return {namespace: 'tag', canonical: canonical(tags[token]), entity: tags[token]};
    return null;
  };

  // Converts a mixed list of refs into canonical archive pointers, keeping only what resolves.
  // Every entity id that survives leaves a conversion record so the diagnosis can be audited.
  const normalizeRefs = (refs = []) => {
    const ok = [], invalid = [], conversions = [];
    for (const ref of Array.isArray(refs) ? refs : []) {
      const token = clean(ref); if (!token) continue;
      const hit = resolve(token);
      if (!hit || !hit.canonical) { invalid.push(token); continue; }
      if (hit.namespace !== 'archive' && hit.canonical !== token) conversions.push({from: token, to: hit.canonical, kind: hit.namespace});
      if (!ok.includes(hit.canonical)) ok.push(hit.canonical);
    }
    return {refs: ok, invalid, conversions};
  };
// The compact registry the repair stage receives: ids plus enough titles to disambiguate, never
  // the full export. It lets a blind model map an id without re-reading a single review.
  const compact = ({filmLimit = 250, reviewLimit = 120, listLimit = 60, tagLimit = 120, sessionLimit = 60} = {}) => ({
    film_ids: Object.values(films).slice(0, filmLimit).map(film => `${film.film_id} | ${clean(film.title)} | ${clean(film.year)}`),
    review_refs: Object.values(reviews).slice(0, reviewLimit).map(review => `${review.review_ref} | ${clean(review.title)}`),
    review_samples: Object.values(reviews).filter(review=>clean(review.text)).slice(0,5).map(review=>`${review.review_ref} | ${clean(review.text).slice(0,400)}`),
    list_ids: Object.values(lists).slice(0, listLimit).map(list => `${list.list_id} | ${clean(list.name)}`),
    tag_ids: Object.values(tags).slice(0, tagLimit).map(tag => `${tag.tag_id} | ${clean(tag.name)}`),
    session_refs: Object.values(sessions).slice(0, sessionLimit).map(session => `${session.session_ref} | ${clean(session.title)} | ${clean(session.date)}`),
    game_films: Object.values(films).filter(film=>Number.isFinite(Number(film.current_rating))).slice(0,filmLimit).map(film=>{
      const review_count=Object.values(reviews).filter(review=>review.film_id===film.film_id).length,rewatch_count=Object.values(sessions).filter(session=>session.film_id===film.film_id&&session.rewatch).length,list_count=Object.values(lists).filter(list=>(list.film_ids||[]).includes(film.film_id)).length;
      return `${film.film_id} | ${clean(film.title)} | ${clean(film.year)} | rating ${film.current_rating} | reviews ${review_count} | rewatches ${rewatch_count} | lists ${list_count}`;
    }),
    tables: (archive.files || []).map(file => clean(file.ref)).filter(ref => ref.endsWith('#table') || ref.endsWith('#text'))
  });

  return {archive, films, reviews, sessions, lists, tags,
    size: {films: Object.keys(films).length, reviews: Object.keys(reviews).length, lists: Object.keys(lists).length, tags: Object.keys(tags).length, sessions: Object.keys(sessions).length},
    resolve, normalizeRefs, filmIdFor, tagIdFor, listIdFor, canonical, compact};
}
// Rewrites attachment ids (film/review/tag/list/session) and evidence_refs before validation, so a
// trivial namespace mistake never costs a session. It only resolves identity: it never adds a fact.
export function normalizeFreeformReferences(payload, registry) {
  const conversions = [];
  if (!payload || typeof payload !== 'object') return {payload, conversions};
  const out = {...payload};
  const absorb = found => { for (const row of found) conversions.push(row); };

  const attachment = item => {
    if (!item || typeof item !== 'object') return item;
    const next = {...item};
    if (item.type === 'film' && item.film_id) { const id = registry.filmIdFor(item.film_id); if (id) next.film_id = id; }
    if (['film_pair', 'film_group'].includes(item.type) && Array.isArray(item.film_ids)) next.film_ids = item.film_ids.map(id => registry.filmIdFor(id) || id);
    if (item.type === 'review_quote' && item.review_ref) { const hit = registry.resolve(item.review_ref); if (hit) next.review_ref = hit.canonical; }
    if (item.type === 'tag' && item.tag_id) { const id = registry.tagIdFor(item.tag_id) || registry.tagIdFor(item.tag); if (id) next.tag_id = id; }
    if (item.type === 'list' && item.list_id) { const id = registry.listIdFor(item.list_id) || registry.listIdFor(item.list_name); if (id) next.list_id = id; }
    if (item.type === 'rewatch' && Array.isArray(item.session_refs)) next.session_refs = item.session_refs.map(ref => registry.resolve(ref)?.canonical || ref);
    return next;
  };
  const refsOf = row => { const result = registry.normalizeRefs(row.evidence_refs); absorb(result.conversions); return result.refs.length ? result.refs : row.evidence_refs; };

  out.moments = (Array.isArray(payload.moments) ? payload.moments : []).map(row => {
    if (!row || typeof row !== 'object') return row;
    const next = {...row, evidence_refs: refsOf(row)};
    if (Array.isArray(row.attachments)) next.attachments = row.attachments.map(attachment);
    return next;
  });
  out.games = (Array.isArray(payload.games) ? payload.games : []).map(row => {
    if (!row || typeof row !== 'object') return row;
    const next = {...row, evidence_refs: refsOf(row)};
    if (Array.isArray(row.film_ids)) next.film_ids = row.film_ids.map(id => registry.filmIdFor(id) || id);
    if (row.copy && Array.isArray(row.copy.reaction_hints)) next.copy = {...row.copy, reaction_hints: row.copy.reaction_hints.map(hint => ({...hint, film_id: hint.film_id ? (registry.filmIdFor(hint.film_id) || hint.film_id) : hint.film_id}))};
    return next;
  });
  if (payload.profile_review && typeof payload.profile_review === 'object') {
    const refs = refsOf(payload.profile_review);
    out.profile_review = {...payload.profile_review, evidence_refs: refs};
  }
  return {payload: out, conversions};
}
