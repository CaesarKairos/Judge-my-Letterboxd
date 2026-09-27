export const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text ?? '';
  return node;
};
export const $ = selector => document.querySelector(selector);
export const types = new Set('typing pause message correction strike profile_stats film film_pair film_group review_quote tag list rating rewatch phrase stat'.split(' '));
export function validateScript(data) {
  if (!data || data.version !== 'presentation-v1') throw new Error('incompatible');
  if (!Array.isArray(data.events) || !data.events.length || data.events.some(e => !e || typeof e.type !== 'string')) throw new Error('invalid');
  for (const e of data.events) {
    if (!types.has(e.type)) { console.warn('Skipped unknown presentation event:', e.type); continue; }
    if (e.type === 'message' && (!Array.isArray(e.segments) || e.segments.some(s => typeof s?.text !== 'string'))) throw new Error('invalid');
    for (const key of ['films', 'stats', 'sessions', 'segments']) if (e[key] != null && !Array.isArray(e[key])) throw new Error('invalid');
  }
  return data;
}
export function safeImage(value) {
  try { const u = new URL(value); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}
