import {discoverTextModels,mergeModels,modelUnavailable,noteModelFailure} from '../models.js';
import {salvageJson} from '../json-repair.js';
import {FREEFORM_JUDGE_PROMPT,JUDGE_VOICE_PROMPT} from '../generated-prompts.js';
import {validateFreeformResponse} from './validator.js';
import {buildFreeformRegistry,normalizeFreeformReferences} from './references.js';
import {repairFreeform} from './repair.js';

const strings={type:'ARRAY',items:{type:'STRING'}},filmIds={type:'ARRAY',items:{type:'STRING'}},attachment={type:'OBJECT',required:['type'],properties:{type:{type:'STRING'},film_id:{type:'STRING'},film_ids:filmIds,review_ref:{type:'STRING'},list_id:{type:'STRING'},list_ref:{type:'STRING'},tag_id:{type:'STRING'},tag:{type:'STRING'},session_refs:filmIds,phrase:{type:'STRING'},title:{type:'STRING'},display_text:{type:'STRING'},values:{type:'ARRAY',items:{type:'OBJECT',properties:{label:{type:'STRING'},value:{type:'STRING'}}}}}};
const role={type:'OBJECT',properties:{id:{type:'STRING'},label:{type:'STRING'},rank:{type:'NUMBER'}}},hint={type:'OBJECT',properties:{film_id:{type:'STRING'},film_key:{type:'STRING'},role_id:{type:'STRING'},text:{type:'STRING'}}},choice={type:'OBJECT',properties:{id:{type:'STRING'},label:{type:'STRING'},reaction:{type:'STRING'}}};
const schema={type:'OBJECT',required:['opening','moments','games','closer','ending','profile_review'],properties:{
  opening:{type:'OBJECT',properties:{greeting:strings,archetype_lead:{type:'STRING'},archetype_phrase:{type:'STRING'},archetype_after:strings,username_line:{type:'STRING'},taste_bit:{type:'OBJECT',properties:{lead:{type:'STRING'},strike:{type:'STRING'},correction:{type:'STRING'},tail:{type:'STRING'}}},judge_claim:{type:'STRING'},transition:strings}},
  moments:{type:'ARRAY',items:{type:'OBJECT',required:['id','label','evidence_refs','attachments','lines'],properties:{id:{type:'STRING'},type:{type:'STRING'},label:{type:'STRING'},evidence_refs:strings,attachments:{type:'ARRAY',items:attachment},lines:strings}}},
  games:{type:'ARRAY',items:{type:'OBJECT',required:['id','type','film_ids','evidence_refs','copy'],properties:{id:{type:'STRING'},type:{type:'STRING'},film_ids:filmIds,evidence_refs:strings,difficulty:{type:'STRING'},why_difficult:{type:'STRING'},copy:{type:'OBJECT',required:['intro'],properties:{intro:{type:'STRING'},instructions:{type:'STRING'},question:{type:'STRING'},confirm_label:{type:'STRING'},reveal_copy:{type:'STRING'},roles:{type:'ARRAY',items:role},reaction_hints:{type:'ARRAY',items:hint},choices:{type:'ARRAY',items:choice},result_reactions:{type:'OBJECT',properties:{match:{type:'STRING'},near_match:{type:'STRING'},chaotic_mismatch:{type:'STRING'}}}}}}}},
  closer:strings,ending:{type:'OBJECT',properties:{title:{type:'STRING'}}},profile_review:{type:'OBJECT',required:['text','evidence_refs'],properties:{text:{type:'STRING'},evidence_refs:strings}}
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
  const repairs=[];
  // Repair whenever the answer is not already perfect: optional damage is preserved while core
  // omissions (opening, games, Profile Review) are repaired before publication.
  if(validated.generation_status!=='complete'){
    const before=validated;
    const outcome=await repairFreeform({payload,validated,registry,env,model,deadline,maxCalls:repairBudget});
    for(const row of outcome.attempts)attempts.push(row);
    if(outcome.repairs.length){
      const again=normalizeFreeformReferences(outcome.payload,registry);
      for(const row of again.conversions)conversions.push(row);
      const after=validateFreeformResponse(again.payload,archive,{registry});
      // A repair that made things worse never wins: the pre-repair session is preserved.
      if(score(after)>=score(before)){payload=again.payload;validated=after;repairs.push(...outcome.repairs);}
    }
  }
  return {...validated,_conversions:conversions,_repairs:repairs};
}
const score=value=>(value.core_contract_complete?1_000_000:0)+(value.opening_valid?100_000:0)+Math.min(value.games?.length||0,value.required_games||0)*10_000+(value.profile_review_valid?5_000:0)+(value.moments?.length||0)*50-(value.moments_invalid?.length||0)*20-(value.attachments_invalid?.length||0);

export async function freeformJudge({archive,locale,env}){
  if(!env.GEMINI_API_KEY)throw new Error('missing_gemini_key');
  const archiveJson=JSON.stringify(archive),limit=Number(env.FREEFORM_MAX_PAYLOAD_CHARS||1800000);
  if(archiveJson.length>limit){const error=new Error('freeform_context_too_large');error.details={payload_chars:archiveJson.length,file_count:archive.archive?.file_count||0};throw error;}
  const systemInstruction=`${JUDGE_VOICE_PROMPT}\n\n${FREEFORM_JUDGE_PROMPT}`;
  const dataPrompt=`Language: ${locale==='en-US'?'English':'Brazilian Portuguese'}. acid_level=0.8.\n<ARCHIVE_DATA>\n${archiveJson}\n</ARCHIVE_DATA>`;
  const discovered=await discoverTextModels(env),configured=[env.GEMINI_FREEFORM_MODEL||env.GEMINI_WRITER_MODEL||env.GEMINI_MODEL||'gemini-flash-latest',...String(env.GEMINI_FREEFORM_FALLBACK_MODELS||env.GEMINI_WRITER_FALLBACK_MODELS||env.GEMINI_FALLBACK_MODELS||'').split(',').map(v=>v.trim()).filter(Boolean)],models=mergeModels(configured,discovered);
  const registry=buildFreeformRegistry(archive);
  const attempts=[],deadline=Date.now()+190000;let lastReason='no_usable_model_response',best=null;
  for(const model of models){
    if(Date.now()>deadline)break;if(modelUnavailable(env,model))continue;
    let thinking=true,useSchema=true;
    for(let attempt=0;attempt<3&&Date.now()<deadline;attempt++){
      const generationConfig={temperature:.8,maxOutputTokens:16384,responseMimeType:'application/json',...(useSchema?{responseSchema:schema}:{}),...(thinking?{thinkingConfig:{thinkingBudget:0}}:{})};
      const body={system_instruction:{parts:[{text:systemInstruction}]},contents:[{role:'user',parts:[{text:dataPrompt}]}],generationConfig};
      let response,result;
      try{response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},body:JSON.stringify(body),signal:AbortSignal.timeout(Math.max(1000,deadline-Date.now()))});result=await response.json();}
      catch(error){attempts.push({model,status:0,error:error.name});lastReason='network_error';continue;}
      const record={model,status:response.status,finishReason:result?.candidates?.[0]?.finishReason||null,schema:useSchema};
      attempts.push(record);
      if(contextFailure(response.status,result)){const error=new Error('freeform_context_too_large');error.details={payload_chars:archiveJson.length,file_count:archive.archive?.file_count||0};throw error;}
      if(!response.ok){
        noteModelFailure(env,model,response.status);
        // Two provider incompatibilities, never content problems: a rejected thinkingConfig, then a
        // rejected responseSchema. The second retries in plain JSON mode so the local validator still runs.
        if(response.status===400&&thinking){thinking=false;attempt--;continue;}
        if(useSchema&&schemaRejected(response.status,result)){useSchema=false;record.schema_rejected=true;lastReason='schema_rejected';attempt--;continue;}
        lastReason=response.status===429?'quota_exceeded':'provider_error';continue;
      }
      const raw=responseText(result),reply=await evaluateReply({raw,archive,registry,env,model,deadline,attempts,repairBudget:6});
      const decorated=reply?{...reply,_model:model,_response_chars:raw.length,_finish_reason:record.finishReason}:null;
      if(decorated&&decorated.core_contract_complete&&decorated.generation_status==='complete')return {...decorated,_attempts:attempts,_request_chars:systemInstruction.length+dataPrompt.length,_main_calls:1};
      if(decorated&&(!best||score(decorated)>score(best)))best=decorated;
      // A publishable optional partial is a fallback, not an excuse to repeat the same model.
      if(decorated?.core_contract_complete)break;
      lastReason=record.finishReason&&record.finishReason!=='STOP'?'truncated_output':'invalid_response';
    }
  }
  if(best?.core_contract_complete)return {...best,_attempts:attempts,_request_chars:systemInstruction.length+dataPrompt.length,_main_calls:1};
  // AI_FAILED means the provider (or the whole subject) failed, never a single wrong reference.
  const error=new Error('AI_FAILED');
  error.details={stage:'freeform_judge',reason:lastReason,attempts,validation_summary:best?.validation_summary||null};
  throw error;
}
