const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
import {ANALYST_PROMPT} from './generated-prompts.js';
import {discoverTextModels,mergeModels,configuredWithoutDiscovery,describeChain,modelUnavailable,noteModelFailure,MODEL_SAFETY_CEILING} from './models.js';
import {ANALYST_SCHEMA,ANALYST_SEMANTICS_SCHEMA,ANALYST_FINDINGS_SCHEMA,ANALYST_GAMES_SCHEMA} from './analyst-schema.js';
import {buildAnalystContext,summarizeAnalystContext} from './analyst-context.js';
import {buildEvidenceRegistry,EVIDENCE_TYPES} from './evidence-registry.js';
import {normalizeSemanticFindings,MAX_SEMANTIC_FINDINGS} from './semantic-findings.js';
import {buildInteractionPool,GAME_MIN_DIFFICULTY,GAME_MAX_SELECTED,GAME_TYPES} from './interaction-pool.js';
import {accountRichness,SEMANTIC_TARGET_HEADROOM} from './editorial-depth.js';
import {isPlayableGame,selectInteractions} from './editorial.js';
import {readModelReply,attemptStatus} from './json-repair.js';

// The prompt and the schema must describe the same contract. top_four_semantics used to be
// demanded by the acceptance gate while the request never declared it, so a model could
// return a perfect selection, omit one array and have the whole stage declared FAILED.
// Two categories of finding exist on purpose: selecting a measurement is curation, and
// discovering a relationship the deterministic pass never measured is analysis.
const webRuntimeContext=({target,pool})=>`WEB RUNTIME CONTEXT
Return JSON with exactly these four arrays: selected, semantic_findings, interaction_candidates, top_four_semantics.
- selected: one object per chosen measurement from deterministic_measurements, copying its id exactly. Never invent an id. observation is a short factual reading of the account and why_interesting explains why it deserves screen time.
- semantic_findings: zero to four relationships YOU found between evidence that no measurement covers (a review plus a rating plus a list, for instance). type is semantic_contrast, semantic_pattern, semantic_exception, semantic_asymmetry, semantic_habit or semantic_callback. evidence_refs lists two to four EXISTING ids; a reference that does not exist rejects the finding. Never write a number here: the backend carries every rating, date and count from the export into the script.
- interaction_candidates: the challenges you pick from interaction_pool (copy its film_keys and difficulty) or another trio with valid film_keys when you found something better. Prefer two challenges of different types. Never invent a film_key, and never write the question, the roles or the punchline: the Writer does that.
- top_four_semantics: MUST contain one entry for each Favorite Film when four favorites exist (and one entry per favorite when there are fewer). film_key MUST be copied exactly from DATA account.top_four[].film_key. ingredients are two to four short semantic ingredients taken from the FILM itself (archetype, setting and/or narrative element), never the final nickname and never a description of the person.
Every array is required. An empty array is valid when there is nothing honest to say; a missing array is not.

SESSION TARGET
${targetLine(target)}
A short session is acceptable, an empty one is not: never pad, never stop at four because four used to be the number.`;

// A target is an exploration objective, never a quota. The dynamic part comes from the account
// itself (see editorial-depth.js); the floor is what still counts as a real session.
const targetLine=({tier,signal,desired_findings,minimum_usable_findings,pool,selected=0})=>
  `This account reads as ${tier} (richness ${signal}; ${pool} measurements available). Aim for about ${desired_findings} strong findings — as many as the account honestly sustains. Never fewer than ${minimum_usable_findings}: below that the session is too thin.${selected?` You have ${selected} so far.`:''}`;

export const ANALYST_EVIDENCE_TYPES=EVIDENCE_TYPES;
// Budgets are documented constants: a regression must be explainable, not guessed.
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
// Semantic findings carry no pool id: their references are resolved against the evidence registry
// later, and a reference that does not exist rejects the finding instead of degrading it.
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
  const semantic_findings=(Array.isArray(parsed?.semantic_findings)?parsed.semantic_findings:[]).map((item,index)=>({
    id:clean(item?.id)||`semantic_${String(index+1).padStart(3,'0')}`,type:clean(item?.type).toLocaleLowerCase(),
    observation:clean(item?.observation),why_interesting:clean(item?.why_interesting),cultural_angle:clean(item?.cultural_angle),
    interestingness:Number(item?.interestingness),confidence:Number(item?.confidence),
    evidence_refs:evidenceRefs(item?.evidence_refs)})).filter(item=>item.type&&item.observation).slice(0,MAX_SEMANTIC_FINDINGS);
  const interaction_candidates=(Array.isArray(parsed?.interaction_candidates)?parsed.interaction_candidates:[]).map((item,index)=>({
    id:clean(item?.id)||`game-${index+1}`,type:clean(item?.type),film_keys:strings(item?.film_keys).slice(0,3),
    difficulty:Number(item?.difficulty),why_difficult:clean(item?.why_difficult),why_interesting:clean(item?.why_interesting),
    from_pool:clean(item?.from_pool),evidence_refs:evidenceRefs(item?.evidence_refs)})).filter(item=>['forced_triage','blind_rank','defend_your_take'].includes(item.type)&&Number.isFinite(item.difficulty)).slice(0,4);
  const top_four_semantics=(Array.isArray(parsed?.top_four_semantics)?parsed.top_four_semantics:[]).map(row=>({
    film_key:clean(row?.film_key),ingredients:strings(row?.ingredients).slice(0,4)})).filter(row=>row.film_key&&row.ingredients.length).slice(0,4);
  return {selected,semantic_findings,interaction_candidates,top_four_semantics};
}

// The editorial selection and the Top 4 semantics are separate sub-contracts: one failing
// must never discard the other. `strong` is what makes a full session; `thin` is still a
// real analysis, and FAILED is reserved for "we could not obtain an analysis at all".
const scoreOf=row=>({interestingness:Number.isFinite(Number(row.interestingness))?Number(row.interestingness):.5,
  confidence:Number.isFinite(Number(row.confidence))?Number(row.confidence):.7});
// `desired` is how far the Analyst should search; `minimum` is when the session is real. A rich
// account that honestly yields six findings is accepted, never failed for missing eight.
export function evaluateEditorialSelection(selected=[],candidates=[],{desired,minimum}={}){
  const count=(selected||[]).length,pool=(candidates||[]).length;
  const strong=(selected||[]).filter(row=>{const {interestingness,confidence}=scoreOf(row);
    const scored=Number.isFinite(Number(row.interestingness))||Number.isFinite(Number(row.confidence));
    return !scored||(interestingness>=ANALYST_MIN_INTERESTINGNESS&&confidence>=ANALYST_MIN_CONFIDENCE);}).length;
  const target=Math.min(Number.isFinite(desired)?desired:4,pool+SEMANTIC_TARGET_HEADROOM);
  const floor=Number.isFinite(minimum)?Math.min(minimum,target):Math.min(target,Math.max(1,pool));
  return {usable:count>0,count,strong_count:strong,target,minimum:floor,strength:count===0?'empty':strong>=floor?'strong':'thin'};
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

// The repairs must receive the material they are asked to inspect. "Copy the ids from
// deterministic_measurements" was useless on its own: the model had no way to know which ids were
// still available, so a repair could not add anything. The projection below is compact (id, type,
// facts, information value) and never resends the account.
const candidateProjection=(candidates,usedIds=[])=>{
  const used=new Set(usedIds);
  return (candidates||[]).filter(row=>!used.has(row.id)).slice(0,40)
    .map(row=>`- ${row.id} | ${row.type} | ${String(row.facts||'').slice(0,180)} | ${JSON.stringify(row.information_value||null).slice(0,90)}`);
};
const gameProjection=pool=>(pool||[]).slice(0,8).map(game=>`- ${game.type} | ${(game.film_keys||[]).join(', ')} | difficulty ${game.difficulty} | ${String(game.why_difficult||'').slice(0,140)}`);

const findingsRepair=(accepted,remaining,{desired,minimum,needsGames,games=[],semanticCount=0}={})=>[
  'Your previous answer was accepted, but the script still needs material.',
  accepted.length?`Findings already accepted, never repeat or rewrite them: ${accepted.join(', ')}.`:'No finding was accepted yet.',
  `You found ${accepted.length} genuinely strong findings: continue reading the rest of the account and look for other genuinely different subjects. The account can support about ${desired}; never fewer than ${minimum}. Never repeat a subject and never fill a quota.`,
  remaining.length?`Remaining deterministic_measurements you have not selected (id | type | facts | information value):\n${remaining.join('\n')}`:'No unselected measurement is left: use semantic_findings over evidence you have already read, relating two to four existing ids.',
  'Do not fill a quota: three excellent findings are better than eight mediocre ones. A shorter session is accepted when the account really has nothing else.',
  semanticCount?`Semantic findings already accepted: ${semanticCount}.`:'',
  needsGames?`The script also needs two challenges of different types. Choose them from interaction_pool (type | film_keys | difficulty | why):\n${games.join('\n')}`:'',
  'Reply with selected, semantic_findings and interaction_candidates. Do not rewrite top_four_semantics.'
].filter(Boolean).join('\n');

const rejectionRepair=(problems,remaining,{pool=[],gamesNeeded=false}={})=>[
  'Your previous answer was rejected: it contained no usable editorial finding.',
  problems.length?`Problems: ${problems.slice(-4).join('; ')}.`:'',
  remaining.length?`Available deterministic_measurements (id | type | facts | information value) — copy ids exactly:\n${remaining.join('\n')}`:'',
  pool.length&&gamesNeeded?`Challenges available in interaction_pool (type | film_keys | difficulty | why):\n${gameProjection(pool).join('\n')}`:'',
  'Reply with one complete JSON object containing selected, semantic_findings, interaction_candidates and top_four_semantics.'
].filter(Boolean).join('\n');

// Games are a layer of the experience, not an editorial finding: when the Analyst does not pick
// from a pool that clearly contains hard choices, it is asked once, with the pool in hand.
const gamesRepair=(pool,accepted=[])=>[
  'The editorial selection is valid and has already been preserved.',
  'Only repair interaction_candidates.',
  `Choose two hard challenges of different types from interaction_pool (type | film_keys | difficulty | why):\n${gameProjection(pool).join('\n')}`,
  accepted.length?`Already accepted challenges, keep them: ${accepted.join(', ')}.`:'',
  'Copy every film_key exactly as it appears, and never invent a film. Reply with one JSON object containing interaction_candidates and nothing else.'
].filter(Boolean).join('\n');


function analystConfigured(env,discovered=[]){
  return [env.GEMINI_ANALYST_MODEL||env.GEMINI_MODEL||'gemini-flash-latest',
    ...String(env.GEMINI_ANALYST_FALLBACK_MODELS||env.GEMINI_FALLBACK_MODELS||(!discovered.length&&env.GEMINI_MODEL_DISCOVERY!=='0'?'gemini-flash-lite-latest':'')).split(',').map(value=>value.trim()).filter(Boolean)];
}
// The Analyst sees the rich, normalized account and selects evidence. It never writes the
// on-screen jokes; the Writer receives only the materialized selection afterwards.
export async function selectEditorialMoments({profile,analysis,raw_export,locale,env}){
  const candidates=analysis.moments||[],topFour=(profile.topFour||[]).slice(0,4);
  // The pool is deterministic: it exists before the model is asked, so the Analyst chooses between
  // real opportunities instead of having to invent every challenge.
  const pool=buildInteractionPool(profile,analysis);
  const target=accountRichness({profile,analysis});
  const empty=(status,reason,extra={})=>({status,reason,model:null,candidate_count:candidates.length,selected:[],semantic_findings:[],semantic_moments:[],
    interaction_candidates:[],top_four_semantics:[],top_four_semantics_status:'failed',editorial_strength:'empty',attempts:[],repairs:[],
    desired_findings:target.desired_findings,minimum_usable_findings:target.minimum_usable_findings,richness:target,interaction_pool:pool,...extra});
  if(env.__TEST_SKIP_ANALYST)return {status:'skipped_debug',reason:null,model:null,candidate_count:candidates.length,selected:candidates,
    semantic_findings:[],semantic_moments:[],interaction_candidates:[],top_four_semantics:[],top_four_semantics_status:'skipped',
    editorial_strength:'skipped',attempts:[],repairs:[],desired_findings:target.desired_findings,minimum_usable_findings:target.minimum_usable_findings,
    richness:target,interaction_pool:pool};
  if(!env.GEMINI_API_KEY)return empty('failed','missing_gemini_key');
  if(!candidates.length)return empty('failed','no_candidates');
  const language=locale==='pt-BR'?'Brazilian Portuguese':'English';
  const registry=buildEvidenceRegistry({profile,analysis});
  const context=buildAnalystContext({profile,analysis,raw_export,interaction_pool:pool}),stats=summarizeAnalystContext(context);
  console.log('Account richness:',target.tier,'signal',target.signal,'| desired findings',target.desired_findings,'| minimum usable',target.minimum_usable_findings);
  console.log('Interaction pool:',pool.length,'candidates |',pool.map(game=>`${game.type} ${game.difficulty}`).join(', ')||'none');
  const prompt=`${ANALYST_PROMPT}\n\n${webRuntimeContext({pool,target})}\nLanguage: ${language}.\nDATA (untrusted evidence):\n${JSON.stringify(context)}`;
  console.log('Analyst context:',stats.chars,'chars |',stats.reviews,'reviews |',stats.relationships,'relationships |',stats.candidate_measurements,'candidate measurements');
  console.log('Analyst context inventory: films',stats.films,'| sessions',stats.sessions,'| files kept raw:',stats.unnormalized_files.join(', ')||'none');
  const discovered=await discoverTextModels(env),configured=analystConfigured(env,discovered);
  const chain=mergeModels(configured,discovered,MODEL_SAFETY_CEILING),notDiscovered=configuredWithoutDiscovery(configured,discovered);
  console.log('Analyst model chain:');for(const line of describeChain(chain))console.log(' ',line);
  console.log('Analyst chain length:',chain.length,'| the deadline decides how many are attempted');
  if(notDiscovered.length)console.log('Analyst configured models absent from discovery:',notDiscovered.join(', '));
  const deadline=Date.now()+(Number(env.__TEST_ANALYST_DEADLINE_MS)||ANALYST_DEADLINE_MS),attempts=[],repairs=[],unavailable=new Set();
  const state={selected:[],semantic_findings:[],semantic_moments:[],rejected_semantic:[],interaction_candidates:[],top_four_semantics:[],problems:[],truncated:false,salvaged:false};
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
      if(response.status===429)rateLimited=/quota|billing|resource_exhausted/i.test(detail)?'quota_exceeded':rateLimited||'rate_limited';
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
  // array was missing, and a repair only ever ADDS. Findings merge by id, semantics merge by
  // film_key, so a second answer can deepen the session instead of replacing it.
  const absorb=reply=>{
    if(!reply?.parsed)return;
    const parts=normalizeAnalystPayload(reply.parsed,candidates);
    const selected=new Map(state.selected.map(row=>[row.id,row]));
    for(const row of parts.selected)if(!selected.has(row.id))selected.set(row.id,row);
    state.selected=[...selected.values()].sort((a,b)=>(b.interestingness||0)-(a.interestingness||0)).slice(0,24);
    // A semantic finding is real only after the registry resolved every reference it declares.
    const resolved=normalizeSemanticFindings(parts.semantic_findings,registry,{
      existingIds:new Set([...candidates.map(row=>row.id),...state.semantic_moments.map(row=>row.id),...state.semantic_findings.map(row=>row.id)])});
    state.semantic_findings=[...state.semantic_findings,...resolved.accepted];
    state.semantic_moments=[...state.semantic_moments,...resolved.accepted];
    state.rejected_semantic=[...state.rejected_semantic,...resolved.rejected];
    if(parts.interaction_candidates.length>state.interaction_candidates.length)state.interaction_candidates=parts.interaction_candidates;
    const merged=new Map(state.top_four_semantics.map(row=>[row.film_key,row]));
    for(const row of parts.top_four_semantics)if(!merged.has(row.film_key))merged.set(row.film_key,row);
    state.top_four_semantics=[...merged.values()].slice(0,4);
    state.truncated=state.truncated||reply.truncated;
    state.salvaged=state.salvaged||reply.salvage_used;
    if(resolved.rejected.length)console.log('Semantic findings rejected:',resolved.rejected.map(row=>`${row.id} ${row.reason}`).join(', '));
    if(!(parts.selected.length||parts.semantic_findings.length||parts.interaction_candidates.length||parts.top_four_semantics.length))
      state.problems.push(reply.truncated?'the answer was cut before any finding':'the answer had no usable finding');
  };
  const editorialNow=()=>evaluateEditorialSelection(state.selected,candidates,{desired:target.desired_findings,minimum:target.minimum_usable_findings});
  const findingCount=()=>state.selected.length+state.semantic_moments.length;
  const usablePoolGames=()=>pool.filter(game=>GAME_TYPES.includes(game.type)&&Number(game.difficulty)>=GAME_MIN_DIFFICULTY);
  const playableGames=()=>state.interaction_candidates.filter(game=>isPlayableGame(game,new Map(profile.films.map(film=>[film.film_key,film]))));
  const gamesNeeded=()=>playableGames().length<GAME_MAX_SELECTED&&usablePoolGames().length>=GAME_MAX_SELECTED;
  // What still has to be asked for, in priority order. `null` means the stage is done.
  const pending=()=>{
    if(!state.selected.length)return {kind:'full'};
    if(!evaluateTopFourSemantics(state.top_four_semantics,topFour).valid)return {kind:'semantics'};
    if(editorialNow().strong_count<target.desired_findings)return {kind:'more'};
    if(gamesNeeded())return {kind:'games'};
    return null;
  };
  const repairRequest=kind=>{
    if(kind==='semantics'){const semantics=evaluateTopFourSemantics(state.top_four_semantics,topFour);
      return {phase:'repair_semantics',schema:ANALYST_SEMANTICS_SCHEMA,text:semanticsRepair(semantics.missing,state.top_four_semantics)};}
    if(kind==='more')return {phase:'repair_findings',schema:ANALYST_FINDINGS_SCHEMA,
      text:findingsRepair(state.selected.map(row=>row.id),candidateProjection(candidates,state.selected.map(row=>row.id)),
        {desired:target.desired_findings,minimum:target.minimum_usable_findings,semanticCount:state.semantic_moments.length,
          needsGames:gamesNeeded(),games:gameProjection(pool.filter(game=>!state.interaction_candidates.some(row=>row.id===game.id)))})};
    if(kind==='games')return {phase:'repair_games',schema:ANALYST_GAMES_SCHEMA,
      text:gamesRepair(pool,state.interaction_candidates.map(row=>row.id))};
    return {phase:'repair_full',schema:ANALYST_SCHEMA,
      text:rejectionRepair(state.problems,candidateProjection(candidates),{pool,gamesNeeded:gamesNeeded()})};
  };
  // Complete means "nothing honest is left to ask for", which is a different question from
  // "did we reach the exploration target". A shorter session is accepted, never failed.
  const complete=()=>pending()===null;
  const stale=new Set();

  // One repair per model, and only for something that is still genuinely pending: a repair that
  // already failed to add material is not repeated on the next model.
  const repairNow=async(model,modelsLeft)=>{
    const need=pending();
    if(!need||stale.has(need.kind))return null;
    const repair=repairRequest(need.kind),missing=evaluateTopFourSemantics(state.top_four_semantics,topFour).missing;
    const before=findingCount(),gamesBefore=playableGames().length,semanticBefore=state.semantic_moments.length;
    console.log('Analyst repair:',repair.phase,'| pending',need.kind,'| findings',before,'| games',gamesBefore);
    repairs.push({model,phase:repair.phase,pending:need.kind,request_chars:repair.text.length});
    const repaired=await call(model,{content:repair.text,schema:repair.schema,phase:repair.phase,modelsLeft});
    if(repaired.reply)absorb(repaired.reply);
    const entry=repairs[repairs.length-1];
    entry.result=repaired.status;
    entry.added={findings:findingCount()-before,semantic:state.semantic_moments.length-semanticBefore,games:playableGames().length-gamesBefore};
    console.log('Analyst repair result:',repaired.status,`| findings +${entry.added.findings} | semantic +${entry.added.semantic} | games +${entry.added.games}`);
    if(repaired.fast)unavailable.add(model);
    // One directed attempt was made and it did not deliver: stop asking for that same thing.
    if(!entry.added.findings&&!entry.added.games)stale.add(need.kind);
    return entry;
  };

  // The chain is walked while time remains, not up to a fixed count: a 404 or a 429 that answers
  // in under a second must never stop a later discovered model from being tried.
  for(const [index,model] of chain.entries()){
    if(!canCall())break;
    if(complete())break;
    if(unavailable.has(model))continue;
    if(modelUnavailable(env,model)){unavailable.add(model);console.log('Analyst skipped (unavailable in this run):',model);continue;}
    const pendingKind=pending()?.kind;
    if(pendingKind&&stale.has(pendingKind))break;
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
    // One targeted repair on the same model: ask for what is missing, keep everything else,
    // and move to the next model if this one cannot provide it.
    if(!canCall())break;
    await repairNow(model,modelsLeft);
    if(complete())break;
  }

  // The challenges are a layer of the experience, not an editorial finding, so the pool is allowed
  // to complete what the Analyst left open — after one directed repair, as the contract asks.
  if(canCall()&&gamesNeeded()&&!stale.has('games')&&served){
    await repairNow(served,1);
  }
  // The two final challenges are chosen here, with the same rule the Script Engine uses: the
  // Analyst's picks first, the pool finishing what is missing, different types preferred. The pool
  // is a fallback OPPORTUNITY, never a fallback judgment.
  const finalGames=selectInteractions(state.interaction_candidates,profile,{pool});
  const poolReady=usablePoolGames().length>=GAME_MAX_SELECTED;
  const gamesGuarantee=poolReady?(finalGames.length>=GAME_MAX_SELECTED?'met':'short'):'not_applicable';
  console.log(`Analyst picked: ${playableGames().length}`);
  console.log(`Final games: ${finalGames.length}${poolReady?' (pool ready)':''}`);
  if(finalGames.length)console.log(finalGames.map((game,index)=>`${index+1}. ${game.type} difficulty ${Number(game.difficulty).toFixed(2)}`).join('\n'));
  if(gamesGuarantee==='short')console.warn(`GAME GUARANTEE MISSED: ${usablePoolGames().length} pool candidates available but only ${finalGames.length} challenge(s) selected`);

  const editorial=editorialNow(),semantics=evaluateTopFourSemantics(state.top_four_semantics,topFour);
  const status=!editorial.usable?'failed':editorial.strength==='strong'?'complete':'thin';
  // The reason says what actually happened: a model answered but produced nothing usable, or
  // no model answered at all. FAILED keeps its literal meaning.
  const reason=status==='failed'?(state.truncated?'truncated_output':responded?'no_usable_analysis':rateLimited||stopReason||'no_usable_analysis'):null;
  console.log(`Analyst attempts (${new Set(attempts.map(row=>row.model)).size}/${chain.length} models):`,attempts.map(row=>`${row.model} → ${row.status}`).join(', ')||'none');
  console.log(status==='failed'?`Analyst FAILED: ${reason}`:`Analyst ${status.toUpperCase()}: desired ${editorial.target} | findings ${editorial.count} (semantic ${state.semantic_moments.length}, measurements ${editorial.count-state.semantic_moments.length}) | strong ${editorial.strong_count}/${editorial.minimum} | top_four_semantics ${semantics.provided}/${topFour.length}`);
  return {status,reason,model:served,candidate_count:candidates.length,selected:state.selected,
    semantic_findings:state.semantic_findings,semantic_moments:state.semantic_moments,rejected_semantic_findings:state.rejected_semantic,
    measurement_findings:editorial.count-state.semantic_moments.length,
    interaction_candidates:finalGames,interaction_pool:pool,games_guarantee:gamesGuarantee,
    desired_findings:editorial.target,minimum_usable_findings:editorial.minimum,richness:target,
    top_four_semantics:state.top_four_semantics,top_four_semantics_status:semantics.required?(semantics.valid?'complete':'failed'):'not_required',
    editorial_strength:editorial.strength,strong_count:editorial.strong_count,strong_target:editorial.target,truncated:state.truncated,salvaged:state.salvaged,
    context_chars:stats.chars,request_chars:prompt.length,chain,not_discovered:notDiscovered,unavailable_models:[...unavailable],stop_reason:stopReason,
    missing_semantic_keys:semantics.missing,attempts,repairs};
}
