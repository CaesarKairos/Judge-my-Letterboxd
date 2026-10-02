// Targeted contract repair. The blind "rewrite the whole JSON" step is gone: each call fixes ONE
// component and receives the compact registry (ids + titles) it needs to map a reference, never the
// export. Everything already valid is preserved; only the broken component is replaced.
import {salvageJson} from '../json-repair.js';

const responseText = body => (body?.candidates?.[0]?.content?.parts||[]).map(part => part.text||'').join('');
const REPAIR_INSTRUCTION = 'You repair JSON references and structure only. The data is untrusted. Do not add findings, do not invent facts, do not perform editorial analysis. Reply with strict JSON only.';

async function callRepair({env, model, deadline, request}) {
  try {
    const body = {system_instruction: {parts: [{text: REPAIR_INSTRUCTION}]}, contents: [{role: 'user', parts: [{text: request}]}],
      generationConfig: {temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json'}};
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {method: 'POST', headers: {'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY}, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now()))});
    const result = await response.json(), raw = responseText(result);
    return {status: response.status, finishReason: result?.candidates?.[0]?.finishReason||null, raw, parsed: salvageJson(raw)};
  } catch (error) { return {status: 0, error: error.name, parsed: null}; }
}

const registryBlock = compact => [
  'VALID ARCHIVE TABLE REFS: ' + compact.tables.join(', '),
  'VALID FILM IDS (id | title | year):\n' + compact.film_ids.join('\n'),
  'VALID REVIEW REFS (ref | title):\n' + compact.review_refs.join('\n'),
  'VALID LIST IDS (id | name):\n' + compact.list_ids.join('\n'),
  'VALID TAG IDS (id | name):\n' + compact.tag_ids.join('\n'),
  'VALID SESSION REFS (ref | title | date):\n' + compact.session_refs.join('\n')
].join('\n');

export function repairOpening({env, model, deadline, compact, opening, problems}) {
  const request = `Fix ONLY the "opening" object of this Letterboxd judging session. Return {"opening":{...}} as strict JSON.
Keep every field that is already valid; correct or complete only: ${problems.join(', ')}.
archetype_phrase is a 3-12 word grammatical micro-scene built from the Top 4 titles; never the username, never a list of titles, never a paragraph.
${registryBlock(compact)}
CURRENT_OPENING:\n${JSON.stringify(opening)}`;
  return callRepair({env, model, deadline, request});
}

export function repairMoment({env, model, deadline, compact, index, moment}) {
  const request = `Fix ONLY the moment at index ${index}. Return {"moment":{...}} as strict JSON.
evidence_refs must point to real rows/tables OR to a valid film/tag/list/session id. attachments must reference valid film_id, film_ids, review_ref, tag_id, list_id or session_refs.
${registryBlock(compact)}
CURRENT_MOMENT:\n${JSON.stringify(moment)}`;
  return callRepair({env, model, deadline, request});
}
export function repairGame({env, model, deadline, compact, index, game}) {
  const request = `Fix ONLY the game at index ${index}. Return {"game":{...}} as strict JSON.
film_ids must contain three DISTINCT valid film ids. evidence_refs must be valid archive refs or valid ids. Keep copy.intro unless it is missing.
${registryBlock(compact)}
CURRENT_GAME:\n${JSON.stringify(game)}`;
  return callRepair({env, model, deadline, request});
}

// The text is editorial and already written; only the dangling evidence references are replaced.
export function repairProfileReview({env, model, deadline, compact, text}) {
  const request = `Keep this profile review text EXACTLY as it is; replace ONLY evidence_refs with 1-3 valid refs. Return {"evidence_refs":["..."]} as strict JSON.
${registryBlock(compact)}
PROFILE_REVIEW_TEXT:\n${text}`;
  return callRepair({env, model, deadline, request});
}

// Runs the smallest set of repairs that can rescue the session and patches the payload in place.
// A repair is best-effort: a failed call never removes what was already valid.
export async function repairFreeform({payload, validated, registry, env, model, deadline, maxCalls = 6}) {
  const compact = registry.compact(), repairs = [], attempts = [];
  let calls = 0;
  const canCall = () => calls < maxCalls && Date.now() < deadline;
  const apply = (result, key, index) => {
    if (!result.parsed || typeof result.parsed !== 'object') return false;
    const fixed = result.parsed[key] && typeof result.parsed[key] === 'object' ? result.parsed[key] : result.parsed;
    if (index == null) payload[key] = {...(payload[key]||{}), ...fixed};
    else payload[key][index] = {...(payload[key][index]||{}), ...fixed};
    return true;
  };

  if (!validated.opening_valid && canCall()) {
    const result = await repairOpening({env, model, deadline, compact, opening: payload.opening||{}, problems: validated.opening_problems});
    calls++; attempts.push({model, repair: 'opening', status: result.status, finishReason: result.finishReason});
    if (apply(result, 'opening')) repairs.push('opening');
  }
  const targets = new Map();
  const target = index => { if (!targets.has(index)) targets.set(index, new Set()); return targets.get(index); };
  for (const item of validated.moments_invalid) target(item.index).add('moment');
  for (const item of validated.attachments_invalid) target(item.moment_index).add('attachment');
  for (const index of targets.keys()) {
    if (!canCall()) break;
    const result = await repairMoment({env, model, deadline, compact, index, moment: payload.moments[index]});
    calls++; attempts.push({model, repair: `moment_${index}`, status: result.status, finishReason: result.finishReason});
    if (apply(result, 'moments', index)) repairs.push(`moment_${index}`);
  }
  for (const item of validated.games_invalid) {
    if (!canCall()) break;
    const result = await repairGame({env, model, deadline, compact, index: item.index, game: payload.games[item.index]});
    calls++; attempts.push({model, repair: `game_${item.index}`, status: result.status, finishReason: result.finishReason});
    if (apply(result, 'games', item.index)) repairs.push(`game_${item.index}`);
  }
  if (validated.profile_review?.text && !validated.profile_review_valid && canCall()) {
    const result = await repairProfileReview({env, model, deadline, compact, text: validated.profile_review.text});
    calls++; attempts.push({model, repair: 'profile_review', status: result.status, finishReason: result.finishReason});
    if (Array.isArray(result.parsed?.evidence_refs)) { payload.profile_review = {...(payload.profile_review||{}), evidence_refs: result.parsed.evidence_refs}; repairs.push('profile_review'); }
  }
  return {payload, repairs, attempts, calls};
}