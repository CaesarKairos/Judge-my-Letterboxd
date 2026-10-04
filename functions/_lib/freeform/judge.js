import {discoverTextModels,mergeModels,modelUnavailable,noteModelFailure} from '../models.js';
import {salvageJson} from '../json-repair.js';
import {FREEFORM_JUDGE_PROMPT,JUDGE_VOICE_PROMPT} from '../generated-prompts.js';
import {validateFreeformResponse} from './validator.js';
import {buildFreeformRegistry,normalizeFreeformReferences} from './references.js';
import {repairCore,repairFreeform} from './repair.js';

const richRun={type:'OBJECT',properties:{kind:{type:'STRING',enum:['text','rating']},text:{type:'STRING'},effect:{type:'STRING',enum:['normal','italic','bold','strike','correction','quote','wave','shake','muted','green','blue','orange']},film_id:{type:'STRING'}}},richLine={type:'OBJECT',required:['runs'],properties:{kind:{type:'STRING',enum:['text','blockquote']},runs:{type:'ARRAY',items:richRun}}},strings={type:'ARRAY',items:{anyOf:[{type:'STRING'},richLine]}},richValue={anyOf:[{type:'STRING'},richLine]},filmIds={type:'ARRAY',items:{type:'STRING'}},attachment={type:'OBJECT',required:['type'],properties:{type:{type:'STRING'},film_id:{type:'STRING'},film_ids:filmIds,review_ref:{type:'STRING'},list_id:{type:'STRING'},list_ref:{type:'STRING'},tag_id:{type:'STRING'},tag:{type:'STRING'},session_refs:filmIds,phrase:{type:'STRING'},title:{type:'STRING'},display_text:{type:'STRING'},values:{type:'ARRAY',items:{type:'OBJECT',properties:{label:{type:'STRING'},value:{type:'STRING'}}}}}};
const role={type:'OBJECT',properties:{id:{type:'STRING'},label:{type:'STRING'},rank:{type:'NUMBER'}}},hint={type:'OBJECT',properties:{film_id:{type:'STRING'},film_key:{type:'STRING'},role_id:{type:'STRING'},text:{type:'STRING'}}},choice={type:'OBJECT',properties:{id:{type:'STRING'},label:{type:'STRING'},reaction:{type:'STRING'}}};
const schema={type:'OBJECT',required:['opening','moments','games','closer','ending','profile_review'],properties:{
  opening:{type:'OBJECT',required:['greeting','archetype_lead','archetype_phrase','archetype_after','username_line','taste_bit','judge_claim','transition'],properties:{greeting:strings,archetype_lead:richValue,archetype_phrase:{type:'STRING'},archetype_after:strings,username_line:richValue,taste_bit:{type:'OBJECT',required:['lead','strike','correction','tail'],properties:{lead:richValue,strike:richValue,correction:richValue,tail:richValue}},judge_claim:richValue,transition:strings}},
  moments:{type:'ARRAY',items:{type:'OBJECT',required:['id','label','evidence_refs','attachments','lines'],properties:{id:{type:'STRING'},type:{type:'STRING'},label:{type:'STRING'},evidence_refs:strings,attachments:{type:'ARRAY',items:attachment},lines:strings}}},
  games:{type:'ARRAY',items:{type:'OBJECT',required:['id','type','film_ids','evidence_refs','copy'],properties:{id:{type:'STRING'},type:{type:'STRING'},film_ids:filmIds,evidence_refs:strings,difficulty:{type:'STRING'},why_difficult:{type:'STRING'},copy:{type:'OBJECT',required:['intro','roles','reaction_hints'],properties:{intro:{type:'STRING'},instructions:{type:'STRING'},question:{type:'STRING'},confirm_label:{type:'STRING'},reveal_copy:{type:'STRING'},roles:{type:'ARRAY',items:role},reaction_hints:{type:'ARRAY',items:hint},choices:{type:'ARRAY',items:choice},result_reactions:{type:'OBJECT',properties:{match:{type:'STRING'},near_match:{type:'STRING'},chaotic_mismatch:{type:'STRING'},historically_tied:{type:'STRING'}}}}}}}},
  closer:strings,ending:{type:'OBJECT',properties:{title:{type:'STRING'}}},profile_review:{type:'OBJECT',required:['text','evidence_refs'],properties:{text:richValue,evidence_refs:{type:'ARRAY',items:{type:'STRING'}}}}
}};

const responseText=body=>(body?.candidates?.[0]?.content?.parts||[]).map(part=>part.text||'').join('');
const contextFailure=(status,body)=>status===413||status===400&&/context|token|too (large|long)|input size/i.test(JSON.stringify(body));
// A 400 that names the response schema is a provider incompatibility, never a content problem.
const schemaRejected=(status,body)=>status===400&&/responseschema|response_schema|response.?mime|schema/i.test(JSON.stringify(body||{}));

// One model reply → normalize references → validate → repair the specific broken components.
// Normalization runs first on purpose: an evidence_ref written as an entity id becomes the real
// pointer before validation can reject it. Repair only sees the compact registry, never the export.
async function evaluateReply({raw,archive,registry,env,model,deadline,attempts,repairBudget}){
  const parsed=salvageJson(raw);
  if(!parsed||typeof parsed!=='object')return null;
  const start=normalizeFreeformReferences(parsed,registry);
  let payload=start.payload;
  const conversions=[...start.conversions];
  let validated=validateFreeformResponse(payload,archive,{registry});
  const coreBeforeRepair=validated.validation_summary;
  const repairs=[];
  // Repair whenever the answer is not already perfect: optional damage is preserved while core
  // omissions (opening, games, Profile Review) are repaired before publication.
  if(validated.generation_status!=='complete'){
    const before=validated;
    const outcome=await repairFreeform({payload,validated,registry,env,model,deadline,maxCalls:repairBudget,revalidate:next=>validateFreeformResponse(next,archive,{registry})});
    for(const row of outcome.attempts)attempts.push(row);
    if(outcome.repairs.length){
      const again=normalizeFreeformReferences(outcome.payload,registry);
      for(const row of again.conversions)conversions.push(row);
      const after=validateFreeformResponse(again.payload,archive,{registry});
      // A repair that made things worse never wins: the pre-repair session is preserved.
      if(score(after)>=score(before)){payload=again.payload;validated=after;repairs.push(...outcome.repairs);}
    }
  }
  const repairReasons=attempts.filter(row=>row.repair&&row.reason).map(row=>row.reason);
  return {...validated,_payload:payload,_repair_reason:strongestReason(repairReasons),_conversions:conversions,_repairs:repairs,_core_before_repair:coreBeforeRepair,_core_after_repair:validated.validation_summary};
}
const score=value=>(value.core_contract_complete?1_000_000:0)+(value.opening_valid?100_000:0)+Math.min(value.games?.length||0,value.required_games||0)*10_000+(value.profile_review_valid?5_000:0)+(value.moments?.length||0)*50-(value.moments_invalid?.length||0)*20-(value.attachments_invalid?.length||0);
const REASON_PRIORITY=['quota_exceeded','rate_limited','provider_error','network_error','truncated_output','core_incomplete','invalid_repair_response','invalid_response'];
const strongestReason=reasons=>REASON_PRIORITY.find(reason=>reasons.includes(reason))||null;

export async function freeformJudge({archive,locale,env}){
  if(!env.GEMINI_API_KEY)throw new Error('missing_gemini_key');
  const archiveJson=JSON.stringify(archive),limit=Number(env.FREEFORM_MAX_PAYLOAD_CHARS||1800000);
  if(archiveJson.length>limit){const error=new Error('freeform_context_too_large');error.details={payload_chars:archiveJson.length,file_count:archive.archive?.file_count||0};throw error;}
  const systemInstruction=`${JUDGE_VOICE_PROMPT}\n\n${FREEFORM_JUDGE_PROMPT}`;
  const dataPrompt=`Language: ${locale==='en-US'?'English':'Brazilian Portuguese'}. acid_level=0.8.\n<ARCHIVE_DATA>\n${archiveJson}\n</ARCHIVE_DATA>`;
  const discovered=await discoverTextModels(env),configured=[env.GEMINI_FREEFORM_MODEL||env.GEMINI_WRITER_MODEL||env.GEMINI_MODEL||'gemini-flash-latest',...String(env.GEMINI_FREEFORM_FALLBACK_MODELS||env.GEMINI_WRITER_FALLBACK_MODELS||env.GEMINI_FALLBACK_MODELS||'').split(',').map(v=>v.trim()).filter(Boolean)],models=mergeModels(configured,discovered);
  const registry=buildFreeformRegistry(archive);
  const attempts=[],deadline=Date.now()+190000;let lastReason='no_usable_model_response',best=null;
  const keepReason=reason=>{lastReason=strongestReason([lastReason,reason].filter(Boolean))||reason;};
  for(const model of models){
    if(Date.now()>deadline)break;if(modelUnavailable(env,model))continue;
    let thinking=true,useSchema=true;
    for(let attempt=0;attempt<2&&Date.now()<deadline;attempt++){
      const generationConfig={temperature:.8,maxOutputTokens:16384,responseMimeType:'application/json',...(useSchema?{responseSchema:schema}:{}),...(thinking?{thinkingConfig:{thinkingBudget:0}}:{})};
      const body={system_instruction:{parts:[{text:systemInstruction}]},contents:[{role:'user',parts:[{text:dataPrompt}]}],generationConfig};
      let response,result;
      try{response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},body:JSON.stringify(body),signal:AbortSignal.timeout(Math.max(1000,Math.min(65000,deadline-Date.now())))});result=await response.json();}
      catch(error){attempts.push({model,status:0,error:error.name});keepReason('network_error');continue;}
      const record={model,status:response.status,finishReason:result?.candidates?.[0]?.finishReason||null,schema:useSchema};
      attempts.push(record);
      if(contextFailure(response.status,result)){const error=new Error('freeform_context_too_large');error.details={payload_chars:archiveJson.length,file_count:archive.archive?.file_count||0};throw error;}
      if(!response.ok){
        noteModelFailure(env,model,response.status);
        // Two provider incompatibilities, never content problems: a rejected thinkingConfig, then a
        // rejected responseSchema. The second retries in plain JSON mode so the local validator still runs.
        if(response.status===400&&thinking){thinking=false;attempt--;continue;}
        if(useSchema&&schemaRejected(response.status,result)){useSchema=false;record.schema_rejected=true;keepReason('schema_rejected');attempt--;continue;}
        if(response.status===429){
          const detail=JSON.stringify(result||{});
          keepReason(/quota|billing|resource_exhausted/i.test(detail)?'quota_exceeded':'rate_limited');
          // Retrying the same model immediately cannot change an account/model rate limit.
          // Continue with the next fallback instead of spending all three attempts on one 429.
          break;
        }
        if(response.status===404)break;
        keepReason('provider_error');continue;
      }
      const raw=responseText(result),reply=await evaluateReply({raw,archive,registry,env,model,deadline,attempts,repairBudget:6});
      const decorated=reply?{...reply,_model:model,_response_chars:raw.length,_finish_reason:record.finishReason}:null;
      if(decorated&&decorated.core_contract_complete&&decorated.generation_status==='complete')return {...decorated,_attempts:attempts,_request_chars:systemInstruction.length+dataPrompt.length,_main_calls:1};
      if(decorated&&(!best||score(decorated)>score(best)))best=decorated;
      // A publishable optional partial is a fallback, not an excuse to repeat the same model.
      if(decorated?.core_contract_complete)break;
      lastReason=strongestReason([reply?._repair_reason,lastReason,record.finishReason&&record.finishReason!=='STOP'?'truncated_output':'core_incomplete'].filter(Boolean))||'invalid_response';
    }
  }
  if(best?.core_contract_complete)return {...best,_attempts:attempts,_request_chars:systemInstruction.length+dataPrompt.length,_main_calls:1};
  let coreRescue={executed:false,result:'not_run'};
  if(best?.moments?.length){
    const rescueDeadline=Date.now()+30000,result=await repairCore({env,model:best._model,deadline:rescueDeadline,compact:registry.compact(),payload:best._payload||best,validated:best});
    const rescueAttempt={model:best._model,repair:'core_rescue',status:result.status,finishReason:result.finishReason,reason:result.reason||null,provider_error:result.provider_error||null};attempts.push(rescueAttempt);coreRescue={executed:true,result:result.parsed?'parsed':result.reason||'failed'};
    if(result.parsed&&typeof result.parsed==='object'){
      const base={...(best._payload||best)},fixed=result.parsed;
      if(fixed.opening)base.opening={...(base.opening||{}),...fixed.opening};
      if(Array.isArray(fixed.games))base.games=[...(best.games||[]),...fixed.games].slice(0,best.required_games||fixed.games.length);
      if(fixed.profile_review)base.profile_review={...(base.profile_review||{}),...fixed.profile_review};
      const normalized=normalizeFreeformReferences(base,registry),rescued=validateFreeformResponse(normalized.payload,archive,{registry});
      coreRescue.result=rescued.core_contract_complete?'complete':'core_incomplete';
      if(rescued.core_contract_complete)return {...rescued,_model:best._model,_attempts:attempts,_repairs:[...(best._repairs||[]),'core_rescue'],_core_before_repair:best._core_before_repair,_core_after_repair:rescued.validation_summary,_core_rescue:coreRescue,_request_chars:systemInstruction.length+dataPrompt.length,_main_calls:1};
      if(score(rescued)>score(best))best={...best,...rescued};
    }
    lastReason=strongestReason([result.reason,lastReason,'core_incomplete'].filter(Boolean))||'core_incomplete';
  }
  // AI_FAILED means the provider (or the whole subject) failed, never a single wrong reference.
  const error=new Error('AI_FAILED');
  const summary=best?.validation_summary||{};
  error.details={stage:'freeform_judge',reason:lastReason,best_core:best?{opening_valid:Boolean(summary.opening),opening_problems:summary.opening_problems||[],games_required:summary.required_games||0,games_valid:summary.games_valid||0,games_missing:summary.games_missing||0,profile_review_valid:Boolean(summary.profile_review),moments_valid:summary.moments_valid||0}:null,repair_attempts:attempts.filter(row=>row.repair),core_rescue:coreRescue,attempts,validation_summary:best?.validation_summary||null};
  throw error;
}
