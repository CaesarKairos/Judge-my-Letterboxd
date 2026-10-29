import {mergeModels,modelUnavailable,noteModelFailure,FREEFORM_MODEL_LIMIT} from '../models.js';
import {workersAiModels,workersAiWithFallback} from '../workers-ai.js';
import {salvageJson} from '../json-repair.js';
import {FREEFORM_JUDGE_PROMPT,JUDGE_VOICE_PROMPT} from '../generated-prompts.js';
import {validateFreeformResponse} from './validator.js';
import {buildFreeformRegistry,normalizeFreeformReferences} from './references.js';
import {repairCore,repairFreeform} from './repair.js';

const rhythm={type:'STRING',enum:['none','short','medium','long']},richRun={type:'OBJECT',properties:{kind:{type:'STRING',enum:['text','rating']},text:{type:'STRING'},effect:{type:'STRING',enum:['normal','italic','bold','strike','correction','quote','wave','shake','muted','green','blue','orange']},film_id:{type:'STRING'}}},richLine={type:'OBJECT',required:['runs'],properties:{kind:{type:'STRING',enum:['text','blockquote']},runs:{type:'ARRAY',items:richRun},pause_before:rhythm,pause_after:rhythm,delivery:rhythm}},strings={type:'ARRAY',items:{anyOf:[{type:'STRING'},richLine]}},richValue={anyOf:[{type:'STRING'},richLine]},filmIds={type:'ARRAY',items:{type:'STRING'}},attachment={type:'OBJECT',required:['type'],properties:{type:{type:'STRING'},film_id:{type:'STRING'},film_ids:filmIds,review_ref:{type:'STRING'},list_id:{type:'STRING'},list_ref:{type:'STRING'},tag_id:{type:'STRING'},tag:{type:'STRING'},session_refs:filmIds,phrase:{type:'STRING'},title:{type:'STRING'},display_text:{type:'STRING'},values:{type:'ARRAY',items:{type:'OBJECT',properties:{label:{type:'STRING'},value:{type:'STRING'}}}}}};
const role={type:'OBJECT',properties:{id:{type:'STRING'},label:{type:'STRING'},rank:{type:'NUMBER'}}},hint={type:'OBJECT',properties:{film_id:{type:'STRING'},film_key:{type:'STRING'},role_id:{type:'STRING'},text:{type:'STRING'}}},choice={type:'OBJECT',properties:{id:{type:'STRING'},label:{type:'STRING'},reaction:{type:'STRING'}}};
const schema={type:'OBJECT',required:['opening','moments','games','closer','ending','profile_review'],properties:{
  opening:{type:'OBJECT',required:['greeting','archetype_lead','archetype_phrase','archetype_after','username_line','taste_bit','judge_claim','transition'],properties:{greeting:strings,archetype_lead:richValue,archetype_phrase:{type:'STRING'},archetype_after:strings,username_line:richValue,taste_bit:{type:'OBJECT',required:['lead','strike','correction','tail'],properties:{lead:richValue,strike:richValue,correction:richValue,tail:richValue}},judge_claim:richValue,transition:strings}},
  moments:{type:'ARRAY',items:{type:'OBJECT',required:['id','label','evidence_refs','attachments','lines'],properties:{id:{type:'STRING'},type:{type:'STRING'},label:{type:'STRING'},pause_before:rhythm,pause_after:rhythm,evidence_refs:strings,attachments:{type:'ARRAY',items:attachment},lines:strings}}},
  games:{type:'ARRAY',items:{type:'OBJECT',required:['id','type','film_ids','evidence_refs','after_moment_id','copy'],properties:{id:{type:'STRING'},type:{type:'STRING'},after_moment_id:{type:'STRING'},pause_before:rhythm,delivery:rhythm,film_ids:filmIds,evidence_refs:strings,difficulty:{type:'STRING'},why_difficult:{type:'STRING'},copy:{type:'OBJECT',required:['intro','instructions','roles','reaction_hints'],properties:{intro:{type:'STRING'},instructions:{type:'STRING'},question:{type:'STRING'},confirm_label:{type:'STRING'},reveal_copy:{type:'STRING'},roles:{type:'ARRAY',items:role},reaction_hints:{type:'ARRAY',items:hint},choices:{type:'ARRAY',items:choice},result_reactions:{type:'OBJECT',properties:{match:{type:'STRING'},near_match:{type:'STRING'},chaotic_mismatch:{type:'STRING'},historically_tied:{type:'STRING'}}}}}}}},
  closer:strings,ending:{type:'OBJECT',properties:{title:{type:'STRING'}}},profile_review:{type:'OBJECT',required:['text','evidence_refs'],properties:{text:richValue,evidence_refs:{type:'ARRAY',items:{type:'STRING'}}}}
}};
export {schema as freeformResponseSchema};

const responseText=body=>body?.choices?.[0]?.message?.content||'';
const contextFailure=(status,body)=>status===413||status===400&&/context|token|too (large|long)|input size/i.test(JSON.stringify(body));
export const categorizeBadRequest=()=> 'invalid_request';
export const thinkingConfigForModel=()=>null;
export const freeformModelArchive=archive=>({
  version:archive.version,archive:archive.archive,
  // Rows are lossless cell arrays; their physical #row ref is the 1-based array position.
  // Keep every source row, but omit per-row ref/index object wrappers and the duplicate entities map.
  files:(archive.files||[]).map(file=>file.format==='csv'?{path:file.path,format:file.format,rows:(file.rows||[]).map(row=>row.cells)}:
    file.format==='binary'?{path:file.path,format:file.format,mime_type:file.mime_type,size:file.size,sha256:file.sha256,base64_in_lossless:Boolean(file.base64)}:
    {path:file.path,format:file.format,raw_text:file.raw_text,ref:file.ref})
});

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
const REASON_PRIORITY=['quota_exceeded','rate_limited','invalid_api_key','invalid_request','model_unavailable','provider_error','timeout','network_error','truncated_output','core_incomplete','invalid_repair_response','invalid_response'];
const strongestReason=reasons=>REASON_PRIORITY.find(reason=>reasons.includes(reason))||null;
export const classifyFinalReason=({attempts,best,fallback='no_usable_model_response'})=>{
  const main=attempts.filter(row=>!row.repair),successful=main.filter(row=>row.status>=200&&row.status<300&&(!row.reason||row.reason==='ok'));
  // A provider response that reached validation supersedes an older transport/quota failure.
  if(successful.length){
    if(best)return 'core_incomplete';
    return successful.some(row=>row.finishReason&&row.finishReason.toLowerCase()!=='stop')?'truncated_output':'invalid_response';
  }
  const attempted=main.filter(row=>row.status>0),limited=attempted.filter(row=>row.status===429),unavailable=attempted.filter(row=>row.status>=500);
  if(attempted.length&&limited.length/attempted.length>=.8){
    const quota=limited.filter(row=>row.reason==='quota_exceeded').length;
    return quota===limited.length?'quota_exceeded':'rate_limited';
  }
  if(attempted.length&&unavailable.length/attempted.length>.5)return 'provider_unavailable';
  // No transport class dominates: this is precisely a mixed failure before usable output.
  if(attempted.length)return 'no_usable_model_response';
  return strongestReason(attempts.map(row=>row.reason).filter(Boolean))||fallback;
};

export async function freeformJudge({archive,locale,env}){
  if(!env.AI||typeof env.AI.run!=='function')throw new Error('workers_ai_binding_missing');
  // `entities` is a derived identity index and duplicates review/session/table contents already
  // present in every source file. Keep the entire lossless file rows/text, while excluding only
  // that redundant index from the model context. The server-side validator retains full entities.
  const modelArchive=freeformModelArchive(archive);
  const archiveJson=JSON.stringify(modelArchive);
  const systemInstruction=`${JUDGE_VOICE_PROMPT}\n\n${FREEFORM_JUDGE_PROMPT}`;
  const dataPrompt=`Language: ${locale==='en-US'?'English':'Brazilian Portuguese'}. acid_level=0.8.\n<ARCHIVE_DATA>\n${archiveJson}\n</ARCHIVE_DATA>`;
  const requestChars=systemInstruction.length+dataPrompt.length;
  // Conservative estimate (one token per two UTF-8 bytes) reserves 16k output tokens and
  // headroom for the model's chat template inside the documented 128k context window.
  // The full archive is retained; oversized uploads fail explicitly instead of being clipped.
  const estimatedInputTokens=Math.ceil(new TextEncoder().encode(systemInstruction+dataPrompt).length/2);
  const maxEstimatedInputTokens=100000;
  if(estimatedInputTokens>maxEstimatedInputTokens){const error=new Error('freeform_context_too_large');error.details={reason:'context_preflight',payload_chars:requestChars,estimated_input_tokens:estimatedInputTokens,max_estimated_input_tokens:maxEstimatedInputTokens,file_count:archive.archive?.file_count||0};throw error;}
  const models=mergeModels(workersAiModels(env),[],FREEFORM_MODEL_LIMIT);
  const registry=buildFreeformRegistry(archive);
  const attempts=[],deadline=Date.now()+190000;let lastReason='no_usable_model_response',best=null,budgetUsed=false;
  const keepReason=reason=>{lastReason=strongestReason([lastReason,reason].filter(Boolean))||reason;};
  for(const model of models){
    if(Date.now()>deadline)break;if(modelUnavailable(env,model))continue;
    try{
      const result=await workersAiWithFallback({env,models:[model],system:systemInstruction,prompt:dataPrompt,temperature:.8,max_completion_tokens:16384,deadline,timeoutMs:65000,phase:'freeform',maxTransientRetries:1});
      attempts.push(...result.attempts.map(row=>({...row,status:row.status>=200&&row.status<300?200:row.status,reason:row.status>=200&&row.status<300?null:row.reason,finishReason:row.finish_reason||null})));
      const raw=result.text,record={model:result.model,status:200,finishReason:result.finish_reason,reason:'ok',usage:result.usage};
      budgetUsed=true;
      const repairBudget=Math.max(0,3-attempts.filter(row=>row.repair).length);
      const reply=await evaluateReply({raw,archive,registry,env,model:result.model,deadline,attempts,repairBudget});
      const decorated=reply?{...reply,_model:result.model,_response_chars:raw.length,_finish_reason:record.finishReason}:null;
      if(decorated&&decorated.core_contract_complete&&decorated.generation_status==='complete')return {...decorated,_attempts:attempts,_request_chars:systemInstruction.length+dataPrompt.length,_main_calls:1};
      if(decorated&&(!best||score(decorated)>score(best)))best=decorated;
      // A publishable optional partial is a fallback, not an excuse to repeat the same model.
      if(decorated?.core_contract_complete)break;
      lastReason=strongestReason([reply?._repair_reason,record.finishReason&&record.finishReason.toLowerCase()!=='stop'?'truncated_output':'core_incomplete'].filter(Boolean))||'invalid_response';
      // A model that returned incomplete JSON is not called again with the full archive.
      if(result.attempts.some(row=>row.model!==model))continue;
      break;
    }catch(error){
      const details=error.details||{},reason=details.reason||'provider_error';
      for(const row of details.attempts||[])attempts.push({...row,model:row.model||model,status:row.status===0?0:row.status,repair:false,provider_error:row.status?{code:row.status,status:String(row.status),message_category:row.reason}:undefined});
      if(contextFailure(details.status||details.attempts?.at(-1)?.status,{error:{message:details.provider_message||''}})){
        const oversized=new Error('freeform_context_too_large');oversized.details={stage:'freeform_judge',reason:'context_exceeded',model,payload_chars:archiveJson.length,attempts};throw oversized;
      }
      keepReason(reason);if(['rate_limited','quota_exceeded','model_unavailable'].includes(reason))noteModelFailure(env,model,details.status||details.attempts?.at(-1)?.status||429);
      if(reason==='invalid_request'){const invalid=new Error('workers_ai_invalid_request');invalid.details={stage:'freeform_judge',reason:'invalid_request',attempts};throw invalid;}
      if(reason==='context_exceeded'){const oversized=new Error('freeform_context_too_large');oversized.details={stage:'freeform_judge',reason:'context_exceeded',model,payload_chars:archiveJson.length,attempts};throw oversized;}
      if(reason==='timeout')keepReason('timeout');if(reason==='network_error')keepReason('network_error');
      if(['rate_limited','quota_exceeded','model_unavailable','provider_error'].includes(reason))continue;
      break;
    }
  }
  if(best?.core_contract_complete)return {...best,_attempts:attempts,_request_chars:systemInstruction.length+dataPrompt.length,_main_calls:1};
  let coreRescue={executed:false,result:'not_run'};
  if(best?.moments?.length&&budgetUsed&&Date.now()<deadline){
    const rescueDeadline=Math.min(deadline,Date.now()+30000),result=await repairCore({env,model:best._model,deadline:rescueDeadline,compact:registry.compact(),payload:best._payload||best,validated:best});
    for(const row of result.attempts||[])attempts.push({...row,model:row.model||best._model,repair:'core_rescue',finishReason:row.finish_reason||null,provider_error:row.status>=400?{code:row.status,status:String(row.status),message_category:row.reason}:null});
    if(!(result.attempts||[]).length)attempts.push({model:best._model,repair:'core_rescue',status:result.status,finishReason:result.finishReason,schema:false,reason:result.reason||null,provider_error:result.provider_error||null});
    coreRescue={executed:true,result:result.parsed?'parsed':result.reason||'failed'};
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
  lastReason=best?'core_incomplete':classifyFinalReason({attempts,best,fallback:lastReason});
  error.details={stage:'freeform_judge',reason:lastReason,best_core:best?{opening_valid:Boolean(summary.opening),opening_problems:summary.opening_problems||[],games_required:summary.required_games||0,games_valid:summary.games_valid||0,games_missing:summary.games_missing||0,profile_review_valid:Boolean(summary.profile_review),moments_valid:summary.moments_valid||0}:null,repair_attempts:attempts.filter(row=>row.repair),core_rescue:coreRescue,attempts,validation_summary:best?.validation_summary||null};
  throw error;
}
