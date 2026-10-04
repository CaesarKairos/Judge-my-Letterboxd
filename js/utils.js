export const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text ?? '';
  return node;
};
// Reviews and hand-written lines may still carry the small HTML subset Letterboxd
// accepts. Real tags become typed parts; unknown tags are dropped, never printed.
const markupTags = {blockquote:'blockquote', strong:'strong', b:'strong', em:'em', i:'em', p:'paragraph'};
const entities = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' '};
export function decodeEntities(value) {
  return String(value ?? '').replace(/&(#[xX][0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g, (match, name) => {
    if (name[0] === '#') {
      const radix = name[1].toLowerCase() === 'x' ? 16 : 10;
      const code = Number.parseInt(name.slice(radix === 16 ? 2 : 1), radix);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return entities[name.toLowerCase()] ?? match;
  });
}
export function parseMarkup(value) {
  const input = String(value ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '');
  const parts = [], stack = [];
  let cursor = 0;
  const push = (type, chunk) => {
    if (!chunk) return;
    const text = decodeEntities(chunk);
    if (!text) return;
    const previous = parts.at(-1);
    if (previous?.type === type) previous.text += text;
    else parts.push({type, text});
  };
  for (const match of input.matchAll(/<\/?\s*([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g)) {
    push(stack.at(-1) || 'text', input.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const closing = match[0][1] === '/', name = match[1].toLowerCase(), type = markupTags[name];
    if (name === 'br') {push(stack.at(-1) || 'text', '\n'); continue;}
    if (!type) continue;
    if (type === 'paragraph' && !closing && parts.length) push(stack.at(-1) || 'text', '\n');
    if (closing) {const at = stack.lastIndexOf(type); if (at >= 0) stack.splice(at);}
    else stack.push(type);
  }
  push(stack.at(-1) || 'text', input.slice(cursor));
  return parts
    .map(part => ({...part, text: part.text.replace(/[ \t]*\n[ \t]*/g, '\n')}))
    // Surrounding spaces stay: they keep inline markup spaced when rendered as siblings.
    .filter(part => part.text.trim());
}
export const plainText = value => parseMarkup(value).map(part => part.text).join(' ').replace(/\s+/g, ' ').trim();
export const richEffects=new Set(['normal','none','italic','bold','strike','correction','quote','blockquote','wave','shake','muted','green','blue','orange']);
export function richRuns(value){
  const source=Array.isArray(value?.runs)?value.runs:(Array.isArray(value)?value:[{text:typeof value==='object'?value?.text:value,effect:value?.kind}]);
  return source.flatMap(run=>parseMarkup(run?.text??'').map(part=>({text:part.text,effect:part.type==='strong'?'bold':part.type==='em'?'italic':part.type==='blockquote'?'quote':richEffects.has(run?.effect)?run.effect:'normal'}))).filter(run=>run.text);
}
export function richPlainText(value){return richRuns(value).map(run=>run.text).join('').replace(/[ \t]*\n[ \t]*/g,'\n').trim();}
export function appendRich(container,value,{profile=false}={}){
  const runs=richRuns(value);let paragraph=null;
  const addParagraph=()=>{paragraph=el('p',profile?'profile-review-paragraph':'judge-message');container.append(paragraph);};
  for(const run of runs){const quote=['quote','blockquote'].includes(run.effect);if(quote){const node=el('blockquote',profile?'profile-review-quote':'judge-quote',run.text);container.append(node);paragraph=null;continue;}if(!paragraph)addParagraph();const tag=run.effect==='bold'?'strong':run.effect==='italic'?'em':run.effect==='strike'?'del':'span',node=el(tag,`judge-run judge-run-${run.effect}`,run.text);paragraph.append(node);}
  return runs;
}
export const $ = selector => document.querySelector(selector);
export const types = new Set('typing pause message correction strike profile_stats film film_pair film_group review_quote tag list tag_list_relationship tag_tag_relationship list_list_relationship rating rewatch phrase stat custom_attachment moment_label game_intro game_forced_triage game_blind_rank game_defend_take game_result'.split(' '));
export function validateScript(data) {
  if (!data || !['presentation-v1','presentation-v2'].includes(data.version)) throw new Error('incompatible');
  if (!Array.isArray(data.events) || !data.events.length || data.events.some(e => !e || typeof e.type !== 'string')) throw new Error('invalid');
  for (const e of data.events) {
    if (!types.has(e.type)) { console.warn('Skipped unknown presentation event:', e.type); continue; }
    if (e.type === 'message' && (!Array.isArray(e.segments) || e.segments.some(s => typeof s?.text !== 'string'))) throw new Error('invalid');
    if (e.type === 'custom_attachment' && (e.title != null && typeof e.title !== 'string' || e.label != null && typeof e.label !== 'string')) throw new Error('invalid');
    if (e.type === 'moment_label' && typeof e.label !== 'string') throw new Error('invalid');
    for (const key of ['films', 'stats', 'sessions', 'segments']) if (e[key] != null && !Array.isArray(e[key])) throw new Error('invalid');
  }
  return data;
}
export function safeImage(value) {
  try { const u = new URL(value); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}
// The site icon is one file, the same one the tab uses: a marked surface loads it as an image
// instead of inlining a second copy, so the gradient id never collides and a missing poster or a
// chosen ZIP keeps the same mark. Decorative by default: the text beside it carries the meaning.
export const ICON = '/images/camera-reels-fill.svg';
export const icon = (className = 'icon', size = 24) => {
  const img = el('img', className);
  img.src = ICON; img.width = size; img.height = size; img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  return img;
};

