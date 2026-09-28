const DURATIONS = new Set(['short', 'medium', 'long']);
import {discoverTextModels,mergeModels} from './models.js';
import {WRITER_PROMPT} from './generated-prompts.js';
// Rhythm keys stay optional in the schema: the model almost always sends them, but one
// missing enum must never invalidate a good answer. Requiring five extra fields per
// reaction used to push the reply over the output limit and truncate the JSON.
const RHYTHM = {evidence_pause: 'medium', after_evidence: 'long', typing: 'short', between_lines: 'medium', after_reaction: 'medium'};
const rhythmField = () => ({type: 'STRING', enum: ['short', 'medium', 'long']});
const clean = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
// The Profile Review imitates the account's own rhythm, so the Writer receives a fingerprint as
// numbers and phrases instead of a pile of full reviews it was explicitly told not to copy.
const styleFingerprint = style => style ? {median_length: style.median_length, average_length: style.average_length,
  average_sentence_length: style.average_sentence_length, short_reviews: style.short_reviews, long_reviews: style.long_reviews,
  markup: style.markup, punctuation: style.punctuation,
  recurring_phrases: (style.recurring?.trigrams || []).slice(0, 6).map(row => row.text),
  openings: (style.recurring?.starts || []).slice(0, 4).map(row => row.text),
  endings: (style.recurring?.ends || []).slice(0, 4).map(row => row.text)} : null;
const schema = {type: 'OBJECT', required: ['greeting', 'archetype_phrase', 'profile_reaction', 'reactions'], properties: {
  greeting: {type: 'STRING'}, archetype_phrase: {type: 'STRING'}, profile_reaction: {type: 'STRING'},
  opening: {type:'OBJECT',properties:{greeting:{type:'ARRAY',items:{type:'STRING'}},archetype_lead:{type:'STRING'},archetype_phrase:{type:'STRING'},archetype_after:{type:'ARRAY',items:{type:'STRING'}},username_line:{type:'STRING'},taste_bit:{type:'OBJECT',properties:{enabled:{type:'BOOLEAN'},lead:{type:'STRING'},strike:{type:'STRING'},correction:{type:'STRING'},tail:{type:'STRING'}}},transition:{type:'ARRAY',items:{type:'STRING'}}}},
  closer:{type:'ARRAY',items:{type:'STRING'}},
  profile_review: {type: 'OBJECT', properties: {lead:{type:'STRING'},full:{type:'STRING'},share:{type:'STRING'},text:{type:'STRING'},style_features_used:{type:'ARRAY',items:{type:'STRING'}}}},
  game_copy:{type:'ARRAY',items:{type:'OBJECT',properties:{id:{type:'STRING'},type:{type:'STRING'},intro:{type:'STRING'},instructions:{type:'STRING'},confirm_label:{type:'STRING'},reveal_copy:{type:'STRING'},question:{type:'STRING'},roles:{type:'ARRAY',items:{type:'OBJECT',properties:{id:{type:'STRING'},rank:{type:'NUMBER'},label:{type:'STRING'}}}},choices:{type:'ARRAY',items:{type:'OBJECT',properties:{id:{type:'STRING'},label:{type:'STRING'},reaction:{type:'STRING'}}}},result_reactions:{type:'OBJECT',additionalProperties:{type:'STRING'}}}}},
  reactions: {type: 'ARRAY', items: {type: 'OBJECT', required: ['id', 'lines'], properties: {
    id: {type: 'STRING'}, lines: {type: 'ARRAY', items: {type: 'STRING'}}, after_beat:{type:'ARRAY',items:{type:'STRING'}},
    evidence_pause: rhythmField(), after_evidence: rhythmField(), typing: rhythmField(), between_lines: rhythmField(), after_reaction: rhythmField()
  }}}
}};

// A reply cut by the output limit is still evidence: close the open string, drop the
// dangling separator and close every open object, then keep whatever still parses.
export function salvageJson(text) {
  const raw = String(text || '').replace(/^[^{[]*/, '').replace(/```[\s\S]*$/, '').trim();
  try { return JSON.parse(raw); } catch {}
  const stack = []; let open = false, escaped = false, out = '', done = false;
  for (const char of raw) {
    if (open) {
      if (escaped) { escaped = false; out += char; continue; }
      if (char === '\\') { escaped = true; out += char; continue; }
      if (char === '"') { open = false; out += char; continue; }
      out += char === '\n' || char === '\r' ? ' ' : char; continue;
    }
    if (char === '"') { open = true; out += char; continue; }
    if (char === '{' || char === '[') { stack.push(char); out += char; continue; }
    if (char === '}' || char === ']') { stack.pop(); out += char; if (!stack.length) { done = true; break; } continue; }
    out += char;
  }
  // The object closed before the end: whatever follows is prose, not data.
  if (done) { try { return JSON.parse(out); } catch { return null; } }
  if (escaped) out = out.slice(0, -1);
  if (open) out += '"';
  out = out.replace(/[,:\s]+$/, '');
  // Inside an object a trailing bare string is a key without a value, so it is dropped;
  // inside an array it is a value cut by the limit, so it is kept.
  if (stack.at(-1) === '{') out = out.replace(/,\s*"[^"]*"\s*$/, '');
  while (stack.length) out = `${out.replace(/[\s,]+$/, '')}${stack.pop() === '{' ? '}' : ']'}`;
  try { return JSON.parse(out); } catch { return null; }
}

export function archetypeIssues(phrase, topFour=[]) {
  const text=clean(phrase),lower=text.toLocaleLowerCase(),issues=[];
  const generic=['cinéfilo','cinefilo','cinephile','film bro','amante de cinema','filósofo do streaming','filosofo do streaming','streaming philosopher'];
  if(!text)issues.push('empty_archetype');
  if(generic.some(label=>lower.includes(label)))issues.push('generic_archetype');
  const titles=(topFour||[]).map(f=>clean(f.title)).filter(Boolean);
  const matches=titles.filter(title=>lower.includes(title.toLocaleLowerCase()));
  if(matches.length>=3)issues.push('title_enumeration');
  if(text.length>150)issues.push('archetype_too_long');
  return issues;
}
const normalizeProfileReview=value=>{
  if(!value||typeof value!=='object')return null;
  const full=clean(value.full||value.text).slice(0,1100),share=clean(value.share).slice(0,600);
  return {lead:clean(value.lead),full,share:share||full.slice(0,360),text:full,style_features_used:(Array.isArray(value.style_features_used)?value.style_features_used:[]).map(clean).filter(Boolean).slice(0,4)};
};
const normalizeGameCopy=value=>(Array.isArray(value)?value:[]).map(game=>({
  id:clean(game?.id),type:clean(game?.type),intro:clean(game?.intro),instructions:clean(game?.instructions),confirm_label:clean(game?.confirm_label),reveal_copy:clean(game?.reveal_copy),question:clean(game?.question),
  roles:(Array.isArray(game?.roles)?game.roles:[]).map(role=>({id:clean(role?.id),rank:Number(role?.rank),label:clean(role?.label)})).filter(role=>role.id&&role.label).slice(0,3),
  choices:(Array.isArray(game?.choices)?game.choices:[]).map(choice=>({id:clean(choice?.id),label:clean(choice?.label),reaction:clean(choice?.reaction)})).filter(choice=>choice.id&&choice.label).slice(0,3),
  result_reactions:Object.fromEntries(Object.entries(game?.result_reactions||{}).map(([key,val])=>[clean(key),clean(val)]).filter(([key,val])=>key&&val))
})).filter(game=>game.id).slice(0,2);

export function normalizeJudgment(payload, ids) {
  const problems = [], known = new Set(ids), reactions = new Map();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {ok: false, problems: ['the answer is not a JSON object'], reactions: []};
  if (!Array.isArray(payload.reactions)) problems.push('reactions is missing or not an array');
  for (const row of Array.isArray(payload.reactions) ? payload.reactions : []) {
    if (!row || typeof row !== 'object') { problems.push('a reaction is not an object'); continue; }
    const id = clean(row.id);
    if (!id) { problems.push('a reaction has no id'); continue; }
    if (!known.has(id)) { problems.push(`unknown evidence id "${id}"`); continue; }
    const lines = (Array.isArray(row.lines) ? row.lines : [row.lines]).map(clean).filter(Boolean).slice(0, 4);
    if (!lines.length) problems.push(`reaction "${id}" has no usable line`);
    const rhythm = {};
    for (const [key, fallback] of Object.entries(RHYTHM)) rhythm[key] = DURATIONS.has(clean(row[key])) ? clean(row[key]) : fallback;
    const after_beat=(Array.isArray(row.after_beat)?row.after_beat:[]).map(clean).filter(Boolean).slice(0,2);
    if (!reactions.has(id)) reactions.set(id, {id, lines,after_beat,...rhythm});
  }
  const missing = ids.filter(id => !reactions.has(id));
  if (missing.length) problems.push(`missing reactions for ${missing.join(', ')}`);
  const greeting = clean(payload.greeting);
  if (!greeting) problems.push('greeting is empty');
  const profile_review=normalizeProfileReview(payload.profile_review);
  const rawOpening=payload.opening&&typeof payload.opening==='object'?payload.opening:{};
  const opening={greeting:(Array.isArray(rawOpening.greeting)?rawOpening.greeting:[greeting]).map(clean).filter(Boolean).slice(0,2),archetype_lead:clean(rawOpening.archetype_lead),archetype_phrase:clean(rawOpening.archetype_phrase)||clean(payload.archetype_phrase),archetype_after:(Array.isArray(rawOpening.archetype_after)?rawOpening.archetype_after:[]).map(clean).filter(Boolean).slice(0,3),username_line:clean(rawOpening.username_line),taste_bit:{enabled:rawOpening.taste_bit?.enabled!==false,lead:clean(rawOpening.taste_bit?.lead),strike:clean(rawOpening.taste_bit?.strike),correction:clean(rawOpening.taste_bit?.correction),tail:clean(rawOpening.taste_bit?.tail)},transition:(Array.isArray(rawOpening.transition)?rawOpening.transition:[]).map(clean).filter(Boolean).slice(0,3)};
  const closer=(Array.isArray(payload.closer)?payload.closer:[]).map(clean).filter(Boolean).slice(0,3);
  return {ok: problems.length === 0, greeting, archetype_phrase: opening.archetype_phrase, profile_reaction: clean(payload.profile_reaction),opening,closer,profile_review,game_copy:normalizeGameCopy(payload.game_copy), reactions: [...reactions.values()], missing, problems};
}
export async function writeJudgment({profile,analysis,locale,env}) {
  if(!env.GEMINI_API_KEY)throw new Error('missing_gemini_key');
  const language=locale==='pt-BR'?'Brazilian Portuguese':'English';
  const evidence=analysis.moments.map(moment=>({id:moment.id,facts:moment.facts}));
  const ids=evidence.map(row=>row.id);
  const topFourSemantics=analysis.top_four_semantics||[];
  const selectedInteractions=analysis.selected_interactions||[];
  const WEB_RUNTIME_CONTEXT=`WEB_RUNTIME_CONTEXT
Language: ${language}.
Return strict JSON matching the supplied schema. Keep the ordered moments exactly as received.
Opening text is free, but its narrative functions are fixed by the canonical specification.
profile_review must contain full and share.
game_copy must contain only ids present in selected_interactions.
For forced_triage return exactly three ranked roles (3,2,1), one-to-one and distinct.
For blind_rank return result_reactions with match, near_match and chaotic_mismatch when useful.
For defend_your_take return 2-3 choices and reactions; any public rating is explicitly TMDb audience context.
Do not expose formulas, chain-of-thought or hidden scoring.`;
  const writerData={handle:profile.handle,overview:analysis.overview,top_four:profile.topFour.map(({film_key,title,year})=>({film_key,title,year})),top_four_semantics:topFourSemantics,
    ordered_moments:analysis.moments.map(moment=>({id:moment.id,type:moment.editorial_type||moment.type,observation:moment.observation,facts:moment.facts,why_interesting:moment.why_interesting,cultural_angle:moment.cultural_angle,evidence:moment})),
    selected_interactions:selectedInteractions.map(game=>({id:game.id,type:game.type,film_keys:game.film_keys,difficulty:game.difficulty_score??game.difficulty,why_difficult:game.why_difficult,why_interesting:game.why_interesting,context:game.context||null,tmdb:game.tmdb||null,review:game.review||null})),
    profile_review_style:styleFingerprint(analysis.review_style),callback_candidates:analysis.callbacks||[],tone:{acid_level:.75}};
  const prompt=`${WRITER_PROMPT}\n\n${WEB_RUNTIME_CONTEXT}\n\nDATA:\n${JSON.stringify(writerData)}`;
  console.log('Writer request:',prompt.length,'chars');

  const configured=[env.GEMINI_WRITER_MODEL||env.GEMINI_MODEL||'gemini-flash-latest',...String(env.GEMINI_WRITER_FALLBACK_MODELS||env.GEMINI_FALLBACK_MODELS||'gemini-3.8-flash,gemini-3.5-flash-lite').split(',').map(value=>value.trim()).filter(Boolean)],models=mergeModels(configured,env.__TEST_SKIP_ANALYST?[]:await discoverTextModels(env));
  const attempts=[];const merged=new Map();const deadline=Date.now()+80000;
  let lastStatus=500,lastModel=models[0],usable=0,greeting='',archetype='',profileReaction='',profileReview=null,gameCopy=[],opening=null,closer=[],problems=[],salvaged=false,stopped=false;
  const seen=()=>ids.filter(id=>!merged.has(id));
  const partial=()=>({greeting,archetype_phrase:archetype,profile_reaction:profileReaction,opening,closer,profile_review:profileReview,game_copy:gameCopy,reactions:[...merged.values()]});
  // Sent back to the model whenever the previous answer was rejected, so each retry
  // carries the reason and the part that is still missing instead of repeating blindly.
  const repair=()=>[prompt,'','Your previous answer was rejected: it was not accepted as a complete script.',
    problems.length?`Problems: ${problems.slice(-8).join('; ')}.`:'',
    seen().length?`Reaction ids still required: ${seen().join(', ')}.`:'',
    stopped?'The last answer was cut by the output limit: be shorter, keep every line under 16 words, rhythm values only short, medium or long.':'',
    merged.size||greeting?`Partial answer to complete, as JSON: ${JSON.stringify(partial()).slice(0,1500)}`:'',
    'Reply with one complete JSON object and nothing else.'].filter(Boolean).join('\n');
  const finish=(model,degraded)=>({...partial(),_model:model,_attempts:attempts,_degraded:degraded||/lite/i.test(model),_salvaged:salvaged,_warnings:[...new Set([...problems,...(/lite/i.test(model)?['writer_served_by_lite']:[])])]});
  const editoriallyCoherent=()=>Boolean(greeting&&(profile.topFour.length!==4||!archetypeIssues(archetype,profile.topFour).length)&&closer.length&&profileReview?.full);
  const absorb=(outcome,cut)=>{
    usable++;stopped=stopped||cut;salvaged=salvaged||Boolean(outcome.salvaged);
    greeting=greeting||outcome.greeting;archetype=archetype||outcome.archetype_phrase;profileReaction=profileReaction||outcome.profile_reaction;profileReview=profileReview||outcome.profile_review;gameCopy=gameCopy.length?gameCopy:outcome.game_copy;opening=opening||outcome.opening;closer=closer.length?closer:outcome.closer;
    for(const row of outcome.reactions)if(!merged.has(row.id))merged.set(row.id,row);
    problems=[...new Set([...problems,...outcome.problems])];
  };

  for(const model of models){
    if(Date.now()>deadline)break;
    lastModel=model;let attempt=0,thinking=true,repairing=false;
    while(attempt<2&&Date.now()<deadline){
      const generationConfig={temperature:.72,maxOutputTokens:8192,responseMimeType:'application/json',responseSchema:schema,...(thinking?{thinkingConfig:{thinkingBudget:0}}:{})};
      let response;
      try{
        response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},body:JSON.stringify({contents:[{role:'user',parts:[{text:repairing?repair():prompt}]}],generationConfig}),signal:AbortSignal.timeout(40000)});
      }catch(error){lastStatus=504;attempts.push({model,status:'network'});console.error('Gemini request failed',model,error.name||error.message);await new Promise(resolve=>setTimeout(resolve,350));continue;}
      lastStatus=response.status;attempts.push({model,status:response.status});
      if(response.ok){
        const body=await response.json(),candidate=body?.candidates?.[0];
        const text=(candidate?.content?.parts||[]).map(part=>part.text||'').join('');
        const reason=String(candidate?.finishReason||'STOP').toUpperCase(),cut=reason!=='STOP'&&!reason.endsWith('_STOP');
        const parsed=text?salvageJson(text):null;
        if(parsed){
          const outcome=normalizeJudgment(parsed,ids);
          const archetypeProblems=profile.topFour.length===4?archetypeIssues(outcome.archetype_phrase,profile.topFour):[];if(archetypeProblems.length)outcome.problems.push(...archetypeProblems);
          outcome.ok=outcome.problems.length===0;outcome.salvaged=cut;absorb(outcome,cut);
          if((outcome.ok||(ids.length&&!seen().length&&greeting))&&(env.__TEST_SKIP_ANALYST||editoriallyCoherent())){problems=outcome.ok?[]:['answer completed from a partially salvaged reply'];return finish(model,false);}
          repairing=true;attempt++;console.error('Gemini reply incomplete',model,reason,`${merged.size}/${ids.length}`,outcome.problems.slice(0,2).join('; '));continue;
        }
        problems=[...new Set([...problems,'the answer was not readable JSON'])];stopped=stopped||cut;repairing=true;attempt++;
        console.error('Gemini reply unusable',model,reason,text.length);continue;
      }
      const detail=(await response.text()).slice(0,300);
      if(response.status===400&&thinking){thinking=false;console.error('Gemini rejected thinkingConfig',model,detail.slice(0,120));continue;}
      console.error('Gemini request failed',model,response.status,detail);
      if([401,403].includes(response.status))break;
      if(![429,500,502,503,504].includes(response.status))break;
      attempt++;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,400*attempt));
    }
    if([401,403].includes(lastStatus))break;
  }
  // The judgment still exists without the model: evidence, stats and opening are all
  // deterministic, so a partial script beats an error screen whenever anything arrived.
  const coverage=ids.length?merged.size/ids.length:0;
  if(usable&&greeting&&merged.size&&coverage>=.7&&(env.__TEST_SKIP_ANALYST||editoriallyCoherent())){
    console.error('Judge degraded to a partial script',`${merged.size}/${ids.length}`,[...new Set(problems)].join('; ').slice(0,300));
    return {...finish(lastModel,true),generation_status:'partial'};
  }
  // Every configured model has already received multiple attempts at this point. If
  // none returned even salvageable JSON, keep the deterministic show running instead
  // of sending the visitor into an error/retry loop. A later upload starts a fresh AI
  // attempt, while this run remains honest: reactions are silent and marked degraded.
  problems=[...new Set([...problems,`no usable model response after ${attempts.length} attempts`])];
  console.error('Judge unavailable after model attempts',attempts.length);
  return {generation_status:'failed',error:'ai_unavailable',retryable:true,deterministic_analysis_available:true,_model:lastModel,_attempts:attempts,_warnings:problems};
}

