// The evidence registry: the only place where an evidence id becomes a real fact.
//
// A semantic finding is allowed to invent a relationship (a review plus a rating plus a list),
// but it is never allowed to invent a FACT. Every reference it declares is resolved here against
// the parsed export; a reference that does not exist rejects the whole finding. The registry also
// materializes the evidence, so the numbers, ratings and review excerpts the user sees come from
// the export, never from the model's prose.
export const EVIDENCE_TYPES = ['film', 'review', 'session', 'rewatch', 'list', 'tag', 'relationship',
  'review_style', 'overview', 'watchlist', 'likes', 'temporal', 'measurement'];

const REVIEW_EXCERPT = 900;
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const key = (type, id) => `${type}|${clean(id)}`;
const slug = value => clean(value).toLocaleLowerCase();

// Relationship ids are readable and stable, and the Analyst context prints exactly these.
export function relationId(relation = {}) {
  const type = clean(relation.type);
  if (type === 'tag_list') return `tag_list-${slug(relation.tag)}-${slug(relation.list)}`;
  if (type === 'tag_tag') return `tag_tag-${slug(relation.left)}-${slug(relation.right)}`;
  if (type === 'list_list') return `list_list-${slug(relation.left)}-${slug(relation.right)}`;
  if (type === 'tag_rating' || type === 'tag_rewatch') return `${type}-${slug(relation.tag)}`;
  if (type === 'list_rating' || type === 'list_rewatch') return `${type}-${slug(relation.list)}`;
  if (type === 'review_style_tag') return `review_style_tag-${slug(relation.tag)}`;
  return [type, slug(relation.tag), slug(relation.list), slug(relation.left), slug(relation.right)].filter(Boolean).join('-');
}

// `focus_text` stays a pointer: the excerpt is the minimum needed to see the cited part.
function excerpt(text, focus) {
  const body = String(text || '');
  const needle = clean(focus);
  if (!needle) return body.slice(0, REVIEW_EXCERPT);
  const at = body.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (at < 0) return body.slice(0, REVIEW_EXCERPT);
  const start = Math.max(0, at - 120);
  return body.slice(start, start + Math.max(REVIEW_EXCERPT, needle.length + 240)).trim();
}

// A film is exposed as the registry's own compact shape, never as the raw export row.
const film = row => (row ? {film_key: row.film_key, title: row.title, year: row.year, rating: row.rating ?? null} : null);

export function buildEvidenceRegistry({profile = {}, analysis = {}} = {}) {
  const entries = new Map();
  const put = (type, id, evidence, label) => { const name = clean(id); if (name) entries.set(key(type, name), {source_type: type, source_id: name, label: clean(label), evidence}); };
  const films = profile.films || [];
  const byFilm = new Map(films.map(row => [row.film_key, row]));

  for (const row of films) put('film', row.film_key, {film: film(row)}, `${row.title} (${row.year}) ${row.rating ?? 'unrated'}`);
  for (const review of profile.reviews || []) put('review', review.review_id, {review: {...review}},
    `${review.review_id} on ${review.title} (${review.year}) ${review.rating ?? 'unrated'}`);
  for (const session of profile.sessions || []) put('session', `session-${session.index}`, {session: {...session}},
    `session ${session.index} on ${session.title} ${session.rating ?? 'unrated'}`);
  for (const list of profile.lists || []) put('list', list.name, {list}, `list ${list.name} (${list.count})`);

  // A tag only exists as evidence where the diary really carries it, so the registry counts the
  // sessions that used it and keeps the films it touched.
  const tags = new Map();
  for (const session of profile.sessions || []) for (const tag of session.tags || []) {
    const group = tags.get(tag) || {name: tag, count: 0, films: []};
    group.count += 1;
    group.films.push(film(byFilm.get(session.film_key)));
    tags.set(tag, group);
  }
  for (const [tag, group] of tags) put('tag', tag, {tag: {...group, films: group.films.filter(Boolean)}}, `tag ${tag} (${group.count})`);

  const sessionsByFilm = new Map();
  for (const session of profile.sessions || []) {
    const group = sessionsByFilm.get(session.film_key) || [];
    group.push({date: session.date, rating: session.rating ?? null, index: session.index});
    sessionsByFilm.set(session.film_key, group);
  }
  for (const [film_key, sessions] of sessionsByFilm) {
    if (sessions.length < 2) continue;
    const review = (profile.reviews || []).find(row => row.film_key === film_key);
    put('rewatch', film_key, {rewatch: {film_key, sessions, review_id: review?.review_id || null}},
      `rewatch ${byFilm.get(film_key)?.title || film_key} (${sessions.length} sessions)`);
  }

  for (const relation of analysis.relationships?.relations || []) put('relationship', relationId(relation), {relationship: {...relation, id: relationId(relation)}}, `relationship ${relationId(relation)}`);
  for (const group of analysis.relationships?.tag_films || []) put('relationship', `tag_films-${slug(group.tag)}`, {tag_films: {...group}}, `tag_films ${group.tag}`);

  put('review_style', 'review_style', {review_style: analysis.review_style || {}}, 'review style fingerprint');
  put('overview', 'overview', {overview: analysis.overview || {}}, 'account overview');
  put('watchlist', 'watchlist', {watchlist: {count: profile.watchlist || 0}}, 'watchlist');
  put('likes', 'likes', {likes: profile.likes || {}}, 'likes');
  put('temporal', 'temporal', {temporal: analysis.temporal || {}}, 'temporal profile');
  for (const moment of analysis.moments || []) put('measurement', moment.id,
    {measurement: {id: moment.id, type: moment.type, facts: moment.facts, information_value: moment.information_value || moment.relationship || null}},
    `measurement ${moment.id}`);

  const resolve = (refs = []) => {
    const ok = [], missing = [];
    for (const ref of Array.isArray(refs) ? refs : []) {
      const type = clean(ref?.source_type).toLocaleLowerCase(), id = clean(ref?.source_id);
      const found = entries.get(key(type, id));
      if (!found) { missing.push({source_type: type || 'unknown', source_id: id}); continue; }
      ok.push({...found, focus_text: clean(ref?.focus_text),
        excerpt: found.evidence.review ? excerpt(found.evidence.review.text, ref?.focus_text) : ''});
    }
    return {ok, missing};
  };

  return {types: EVIDENCE_TYPES.slice(), size: entries.size, get: (type, id) => entries.get(key(type, id)) || null, resolve};
}
