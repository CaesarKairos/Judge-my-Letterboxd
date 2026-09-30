const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
import {ANALYST_PROMPT} from './generated-prompts.js';
import {discoverTextModels,mergeModels,configuredWithoutDiscovery,describeChain,modelUnavailable,noteModelFailure,MODEL_SAFETY_CEILING} from './models.js';
import {ANALYST_SCHEMA,ANALYST_SEMANTICS_SCHEMA} from './analyst-schema.js';
import {buildAnalystContext,summarizeAnalystContext} from './analyst-context.js';
import {readModelReply,attemptStatus} from './json-repair.js';

// The prompt and the schema must describe the same contract. top_four_semantics used to be
// demanded by the acceptance gate while the request never declared it, so a model could
// return a perfect selection, omit one array and have the whole stage declared FAILED.
const WEB_RUNTIME_CONTEXT=`WEB RUNTIME CONTEXT
Return JSON with exactly these three arrays: selected, interaction_candidates, top_four_semantics.
- selected: one object per chosen measurement from deterministic_measurements, copying its id exactly. Never invent an id. observation is a short factual reading of the account and why_interesting explains why it deserves screen time.
- interaction_candidates: zero to four genuinely hard choices using forced_triage, blind_rank or defend_your_take. film_keys must exist in DATA. Never force a game; the Script Engine applies thresholds and chooses at most two.
- top_four_semantics: MUST contain one entry for each Favorite Film when four favorites exist (and one entry per favorite when there are fewer). film_key MUST be copied exactly from DATA account.top_four[].film_key. ingredients are two to four short semantic ingredients taken from the FILM itself (archetype, setting and/or narrative element), never the final nickname and never a description of the person.
Every array is required. An empty array is valid when there is nothing honest to say; a missing array is not.`;

// Budgets are documented constants: a regression must be explainable, not guessed.
export const ANALYST_STRONG_FINDINGS=4;        // a full session wants this many; never a quota
export const ANALYST_MAX_OUTPUT_TOKENS=8192;   // 4096 could not hold 12-20 findings plus games plus Top 4
export const ANALYST_REQUEST_TIMEOUT_MS=20000; // one slow model may not consume the whole stage
export const ANALYST_MIN_REQUEST_TIMEOUT_MS=8000; // but the tail of the chain still gets a try
export const ANALYST_DEADLINE_MS=75000;        // shared by every attempt of the stage
// Safety ceilings only, for a runaway loop: the deadline is what really limits the chain, so a
// model discovered at position 20 is still attempted while there is time left.
export const ANALYST_CALL_CEILING=24;
export const ANALYST_SERVER_RETRY_MS=400;      // one short retry after a 5xx, never a loop
export const ANALYST_MIN_INTERESTINGNESS=.62;
export const ANALYST_MIN_CONFIDENCE=.6;
const RETRYABLE=new Set([500,502,503,504]);
const FAST_FAILURE=new Set([400,401,403,404,422,429]);

const strings=value=>Array.isArray(value)?value.map(clean).filter(Boolean):[];
// evidence_refs are a pointer, never prose: keep the declared shape and drop noise.
const evidenceRefs=value=>(Array.isArray(value)?value:[]).map(item=>typeof item==='string'
  ?{source_type:'unknown',source_id:clean(item),focus_text:''}
  :{source_type:clean(item?.source_type),source_id:clean(item?.source_id),focus_text:clean(item?.focus_text)}).filter(row=>row.source_id||row.source_type);

// Only ids that exist in the candidate pool survive; an invented id is dropped, never trusted.
export function normalizeAnalystPayload(parsed,candidates){
  const known=new Map((candidates||[]).map(moment=>[moment.id,moment]));
  const selected=(Array.isArray(parsed?.selected)?parsed.selected:[]).map(item=>{
    const moment=known.get(clean(item?.id)),observation=clean(item?.observation);
    if(!moment||!observation)return null;
    return {...moment,editorial_type:clean(item?.type),observation,why_interesting:clean(item?.why_interesting),
      cultural_angle:clean(item?.cultural_angle),interestingness:Number(item?.interestingness),confidence:Number(item?.confidence),
      evidence_refs:evidenceRefs(item?.evidence_refs),film_keys:strings(item?.film_keys),
      related_tags:strings(item?.related_tags),related_lists:strings(item?.related_lists)};
  }).filter(Boolean).slice(0,20);
  const interaction_candidates=(Array.isArray(parsed?.interaction_candidates)?parsed.interaction_candidates:[]).map((item,index)=>({
    id:clean(item?.id)||`game-${index+1}`,type:clean(item?.type),film_keys:strings(item?.film_keys).slice(0,3),
    difficulty:Number(item?.difficulty),why_difficult:clean(item?.why_difficult),why_interesting:clean(item?.why_interesting),
    evidence_refs:evidenceRefs(item?.evidence_refs)})).filter(item=>['forced_triage','blind_rank','defend_your_take'].includes(item.type)&&Number.isFinite(item.difficulty)).slice(0,4);
  const top_four_semantics=(Array.isArray(parsed?.top_four_semantics)?parsed.top_four_semantics:[]).map(row=>({
    film_key:clean(row?.film_key),ingredients:strings(row?.ingredients).slice(0,4)})).filter(row=>row.film_key&&row.ingredients.length).slice(0,4);
  return {selected,interaction_candidates,top_four_semantics};
}

// The editorial selection and the Top 4 semantics are separate sub-contracts: one failing
// must never discard the other. `strong` is what makes a full session; `thin` is still a
// real analysis, and FAILED is reserved for "we could not obtain an analysis at all".
const scoreOf=row=>({interestingness:Number.isFinite(Number(row.interestingness))?Number(row.interestingness):.5,
  confidence:Number.isFinite(Number(row.confidence))?Number(row.confidence):.7});
export function evaluateEditorialSelection(selected=[],candidates=[]){
  const count=(selected||[]).length,pool=(candidates||[]).length;
  const strong=(selected||[]).filter(row=>{const {interestingness,confidence}=scoreOf(row);
    const scored=Number.isFinite(Number(row.interestingness))||Number.isFinite(Number(row.confidence));
    return !scored||(interestingness>=ANALYST_MIN_INTERESTINGNESS&&confidence>=ANALYST_MIN_CONFIDENCE);}).length;
  const target=Math.min(ANALYST_STRONG_FINDINGS,Math.max(1,pool));
  return {usable:count>0,count,strong_count:strong,target,strength:count===0?'empty':strong>=target?'strong':'thin'};
}

export function evaluateTopFourSemantics(rows=[],topFour=[]){
  const favorites=(topFour||[]).slice(0,4),required=favorites.length===4;
  const seen=new Set((rows||[]).map(row=>row.film_key));
  const missing=required?favorites.filter(film=>!seen.has(film.film_key)):[];
  return {required,valid:!required||missing.length===0,provided:(rows||[]).length,missing};
}

// The repair asks only for what is missing, with the exact keys, and never resends the whole
// account: the selection stays preserved, only the absent contract travels back.
const semanticsRepair=(films,preserved)=>[
  'The editorial selection is valid and has already been preserved.',
  'Only repair top_four_semantics.',
  'Return one entry for each of these exact film_keys:',
  ...films.map(film=>`- ${film.film_key} | ${film.title} (${film.year})`),
  'ingredients: two to four short semantic ingredients taken from the FILM itself (archetype, setting and/or narrative element), never the final nickname and never a description of the person.',
  preserved?.length?`Already accepted entries, keep them as they are: ${JSON.stringify(preserved)}.`:'',
  'Do not rewrite selected. Reply with one JSON object containing top_four_semantics and nothing else.'
].filter(Boolean).join('\n');

const findingsRepair=(accepted,pool)=>[
  'Your previous answer was accepted, but the script still needs material.',
  accepted.length?`Findings already accepted, never repeat or rewrite them: ${accepted.join(', ')}.`:'No finding was accepted yet.',
  `Inspect the remaining candidate pool (${pool} measurements available) and add other findings only if they are genuinely strong.`,
  'Do not fill a quota: three excellent findings are better than eight mediocre ones.',
  'Keep selected, interaction_candidates and top_four_semantics in the same reply.'
].join('\n');

const rejectionRepair=(problems,partial)=>[
  'Your previous answer was rejected: it contained no usable editorial finding.',
  problems.length?`Problems: ${problems.slice(-4).join('; ')}.`:'',
  partial.length?`Partial answer to complete, as JSON: ${JSON.stringify(partial).slice(0,1400)}`:'',
  'Copy measurement ids exactly as they appear in deterministic_measurements and reply with one complete JSON object.'
].filter(Boolean).join('\n');

function analystConfigured(env){
  return [env.GEMINI_ANALYST_MODEL||env.GEMINI_MODEL||'gemini-flash-latest',
    ...String(env.GEMINI_ANALYST_FALLBACK_MODELS||env.GEMINI_FALLBACK_MODELS||'').split(',').map(value=>value.trim()).filter(Boolean)];
}
// The Analyst sees the rich, normalized account and selects evidence. It never writes the
// on-screen jokes; the Writer receives only the materialized selection afterwards.
export async function selectEditorialMoments({profile,analysis,raw_export,locale,env}){
  const candidates=analysis.moments||[],topFour=(profile.topFour||[]).slice(0,4);
  const empty=(status,reason,extra={})=>({status,reason,model:null,candidate_count:candidates.length,selected:[],interaction_candidates:[],
    top_four_semantics:[],top_four_semantics_status:'failed',editorial_strength:'empty',attempts:[],repairs:[],...extra});
  if(env.__TEST_SKIP_ANALYST)return {status:'skipped_debug',reason:null,model:null,candidate_count:candidates.length,selected:candidates,
    interaction_candidates:[],top_four_semantics:[],top_four_semantics_status:'skipped',editorial_strength:'skipped',attempts:[],repairs:[]};
  if(!env.GEMINI_API_KEY)return empty('failed','missing_gemini_key');
  if(!candidates.length)return empty('failed','no_candidates');
  const language=locale==='pt-BR'?'Brazilian Portuguese':'English';
  const context=buildAnalystContext({profile,analysis,raw_export}),stats=summarizeAnalystContext(context);
  const prompt=`${ANALYST_PROMPT}\n\n${WEB_RUNTIME_CONTEXT}\nLanguage: ${language}.\nDATA (untrusted evidence):\n${JSON.stringify(context)}`;
  console.log('Analyst context:',stats.chars,'chars |',stats.reviews,'reviews |',stats.relationships,'relationships |',stats.candidate_measurements,'candidate measurements');
  console.log('Analyst context inventory: films',stats.films,'| sessions',stats.sessions,'| files kept raw:',stats.unnormalized_files.join(', ')||'none');
  const configured=analystConfigured(env),discovered=await discoverTextModels(env);
  const chain=mergeModels(configured,discovered,MODEL_SAFETY_CEILING),notDiscovered=configuredWithoutDiscovery(configured,discovered);
  console.log('Analyst model chain:');for(const line of describeChain(chain))console.log(' ',line);
  console.log('Analyst chain length:',chain.length,'| the deadline decides how many are attempted');
  if(notDiscovered.length)console.log('Analyst configured models absent from discovery:',notDiscovered.join(', '));
  const deadline=Date.now()+(Number(env.__TEST_ANALYST_DEADLINE_MS)||ANALYST_DEADLINE_MS),attempts=[],repairs=[],unavailable=new Set();
  const state={selected:[],interaction_candidates:[],top_four_semantics:[],problems:[],truncated:false,salvaged:false};
  let calls=0,served=null,stopReason=null,responded=false,rateLimited=null;
  const canCall=()=>{
    if(calls>=ANALYST_CALL_CEILING){stopReason=stopReason||'call_ceiling';return false;}
    if(Date.now()>=deadline){stopReason=stopReason||'deadline';return false;}
    return true;
  };
  const isServerError=outcome=>String(outcome?.status||'').startsWith('http_5');

  // One HTTP call, recorded whatever happens. `fast` means "never try this model again in
  // this session": a 404 or a 429 will not answer differently a few hundred milliseconds
  // later, so the chain advances instead of sleeping on the same model.
  // A slow model may not eat the whole stage: the first models keep the full cap, and every
  // remaining model reserves a minimum slice of the shared deadline, so the tail of the chain
  // is still attempted instead of being starved by the two first attempts.
  const timeoutFor=modelsLeft=>Math.max(ANALYST_MIN_REQUEST_TIMEOUT_MS,
    Math.min(ANALYST_REQUEST_TIMEOUT_MS,deadline-Date.now()-ANALYST_MIN_REQUEST_TIMEOUT_MS*Math.max(0,modelsLeft-1)));
  const call=async(model,{content,schema,phase,thinking=true,modelsLeft=1})=>{
    const timeout=timeoutFor(modelsLeft),started=Date.now();
    calls++;
    let response;
    try{
      response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',
        headers:{'Content-Type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},signal:AbortSignal.timeout(timeout),
        body:JSON.stringify({contents:[{parts:[{text:content}]}],generationConfig:{temperature:.25,maxOutputTokens:ANALYST_MAX_OUTPUT_TOKENS,
          responseMimeType:'application/json',responseSchema:schema,...(thinking?{thinkingConfig:{thinkingBudget:0}}:{})}})});
    }catch(error){
      const status=error?.name==='TimeoutError'?'timeout':'network';
      attempts.push({model,phase,status,timeout_ms:timeout,duration_ms:Date.now()-started});stopReason=stopReason||status;return {status,fast:false};
    }
    const duration=Date.now()-started;
    if(!response.ok){
      const detail=(await response.text().catch(()=>'')).slice(0,200);
      // A non-2xx answer is not generation output: it is recorded as http + provider_error +
      // detail + duration, and never parsed as a (missing) model reply. That misleading
      // "parse_error" in the old diagnostic came from reading an error body as a generation.
      const providerError=(()=>{try{const body=JSON.parse(detail);return {code:body?.error?.code??response.status,status:body?.error?.status||'',message:String(body?.error?.message||'').slice(0,140)};}catch{return {code:response.status,status:'',message:detail.slice(0,140)};}})();
      // A 429 is a fact about the key or the account, not about this model: it is kept so the
      // failure can say "quota" instead of a generic timeout, and the model is not retried.
      if(response.status===429)rateLimited=/quota/i.test(detail)?'quota_exceeded':rateLimited||'rate_limited';
      noteModelFailure(env,model,response.status);
      attempts.push({model,phase,status:attemptStatus({status:response.status,ok:false}),http:response.status,provider_error:providerError,detail,timeout_ms:timeout,duration_ms:duration});
      if(response.status===400&&thinking)return {status:'http_400',retry_without_thinking:true,fast:false};
      return {status:attemptStatus({status:response.status,ok:false}),http:response.status,fast:FAST_FAILURE.has(response.status)||!RETRYABLE.has(response.status)&&response.status>=500};
    }
    const payload=await response.json().catch(()=>null),candidate=payload?.candidates?.[0];
    const text=(candidate?.content?.parts||[]).map(part=>part.text||'').join('');
    const reply=readModelReply(text,candidate?.finishReason);
    const status=attemptStatus({status:response.status,ok:true,reply});
    // MAX_TOKENS is not an invalid response: it is a truncated one, and readModelReply has
    // already kept whatever arrived before the cut.
    attempts.push({model,phase,status:status||'ok',http:response.status,finishReason:reply.reason,response_chars:text.length,timeout_ms:timeout,
      json:reply.parsed?(reply.salvage_used?'salvaged':'valid'):'unreadable',parse_error:reply.parsed?undefined:reply.parse_error,duration_ms:duration});
    return {status:status||'ok',reply,fast:false};
  };
  // Whatever arrived is preserved: a valid selection is never thrown away because another
  // array was missing, and semantics from different attempts are merged by film_key.
  const absorb=reply=>{
    if(!reply?.parsed)return;
    const parts=normalizeAnalystPayload(reply.parsed,candidates);
    if(parts.selected.length>state.selected.length)state.selected=parts.selected;
    if(parts.interaction_candidates.length>state.interaction_candidates.length)state.interaction_candidates=parts.interaction_candidates;
    const merged=new Map(state.top_four_semantics.map(row=>[row.film_key,row]));
    for(const row of parts.top_four_semantics)if(!merged.has(row.film_key))merged.set(row.film_key,row);
    state.top_four_semantics=[...merged.values()].slice(0,4);
    state.truncated=state.truncated||reply.truncated;
    state.salvaged=state.salvaged||reply.salvage_used;
    if(!(parts.selected.length||parts.interaction_candidates.length||parts.top_four_semantics.length))
      state.problems.push(reply.truncated?'the answer was cut before any finding':'the answer had no usable finding');
  };
  const repairRequest=()=>{
    const semantics=evaluateTopFourSemantics(state.top_four_semantics,topFour);
    if(state.selected.length&&!semantics.valid)return {phase:'repair_semantics',schema:ANALYST_SEMANTICS_SCHEMA,text:semanticsRepair(semantics.missing,state.top_four_semantics)};
    if(state.selected.length)return {phase:'repair_findings',schema:ANALYST_SCHEMA,text:findingsRepair(state.selected.map(row=>row.id),candidates.length)};
    return {phase:'repair_full',schema:ANALYST_SCHEMA,text:rejectionRepair(state.problems,state)};
  };
  const complete=()=>evaluateEditorialSelection(state.selected,candidates).strength==='strong'&&evaluateTopFourSemantics(state.top_four_semantics,topFour).valid;

  // The chain is walked while time remains, not up to a fixed count: a 404 or a 429 that answers
  // in under a second must never stop a later discovered model from being tried.
  for(const [index,model] of chain.entries()){
    if(!canCall())break;
    if(unavailable.has(model))continue;
    if(modelUnavailable(env,model)){unavailable.add(model);console.log('Analyst skipped (unavailable in this run):',model);continue;}
    const modelsLeft=chain.length-index;
    let thinking=true,outcome=await call(model,{content:prompt,schema:ANALYST_SCHEMA,phase:'initial',modelsLeft});
    if(outcome.retry_without_thinking){thinking=false;stopReason=null;console.log('Analyst rejected thinkingConfig:',model);
      outcome=await call(model,{content:prompt,schema:ANALYST_SCHEMA,phase:'initial',thinking:false,modelsLeft});}
    // A 5xx gets exactly one short retry while there is budget; otherwise the chain advances.
    if(isServerError(outcome)&&canCall()){
      await new Promise(resolve=>setTimeout(resolve,ANALYST_SERVER_RETRY_MS));
      if(canCall())outcome=await call(model,{content:prompt,schema:ANALYST_SCHEMA,phase:'retry_5xx',modelsLeft});
    }
    if(outcome.reply){absorb(outcome.reply);responded=true;}
    if(outcome.fast){unavailable.add(model);continue;}
    if(isServerError(outcome)||!outcome.reply){unavailable.add(model);continue;}
    served=model;
    if(complete())break;
    // One targeted repair on the same model: ask for the missing contract, keep everything
    // else, and move to the next model if this one cannot provide it.
    if(!canCall())break;
    const repair=repairRequest(),missing=evaluateTopFourSemantics(state.top_four_semantics,topFour).missing;
    console.log('Analyst repair:',repair.phase,'| missing semantic film_keys',JSON.stringify(missing));
    repairs.push({model,phase:repair.phase,missing,request_chars:repair.text.length});
    const repaired=await call(model,{content:repair.text,schema:repair.schema,phase:repair.phase,modelsLeft});
    if(repaired.reply)absorb(repaired.reply);
    repairs[repairs.length-1].result=repaired.status;
    if(repaired.reply)console.log('Analyst repair result:',repaired.status,'| top_four_semantics',
      evaluateTopFourSemantics(state.top_four_semantics,topFour).provided,'/',topFour.length);
    if(repaired.fast)unavailable.add(model);
    if(complete())break;
  }

  const editorial=evaluateEditorialSelection(state.selected,candidates),semantics=evaluateTopFourSemantics(state.top_four_semantics,topFour);
  const status=!editorial.usable?'failed':editorial.strength==='strong'?'complete':'thin';
  // The reason says what actually happened: a model answered but produced nothing usable, or
  // no model answered at all. FAILED keeps its literal meaning.
  const reason=status==='failed'?(state.truncated?'truncated_output':responded?'no_usable_analysis':rateLimited||stopReason||'no_usable_analysis'):null;
  console.log(`Analyst attempts (${new Set(attempts.map(row=>row.model)).size}/${chain.length} models):`,attempts.map(row=>`${row.model} → ${row.status}`).join(', ')||'none');
  console.log(status==='failed'?`Analyst FAILED: ${reason}`:`Analyst ${status.toUpperCase()}: selected ${editorial.count} (strong ${editorial.strong_count}/${editorial.target}) | top_four_semantics ${semantics.provided}/${topFour.length}`);
  return {status,reason,model:served,candidate_count:candidates.length,selected:state.selected,interaction_candidates:state.interaction_candidates,
    top_four_semantics:state.top_four_semantics,top_four_semantics_status:semantics.required?(semantics.valid?'complete':'failed'):'not_required',
    editorial_strength:editorial.strength,strong_count:editorial.strong_count,strong_target:editorial.target,truncated:state.truncated,salvaged:state.salvaged,
    context_chars:stats.chars,request_chars:prompt.length,chain,not_discovered:notDiscovered,unavailable_models:[...unavailable],stop_reason:stopReason,
    missing_semantic_keys:semantics.missing,attempts,repairs};
}
