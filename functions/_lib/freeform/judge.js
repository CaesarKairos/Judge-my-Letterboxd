import {discoverTextModels,mergeModels,modelUnavailable,noteModelFailure} from '../models.js';
import {salvageJson} from '../json-repair.js';
import {FREEFORM_JUDGE_PROMPT,JUDGE_VOICE_PROMPT} from '../generated-prompts.js';
import {validateFreeformResponse} from './validator.js';

const schema={type:'OBJECT',required:['opening','moments','closer','profile_review'],properties:{
  opening:{type:'OBJECT',properties:{greeting:{type:'ARRAY',items:{type:'STRING'}},archetype_lead:{type:'STRING'},archetype_phrase:{type:'STRING'},archetype_after:{type:'ARRAY',items:{type:'STRING'}},username_line:{type:'STRING'},taste_bit:{type:'OBJECT',properties:{lead:{type:'STRING'},strike:{type:'STRING'},correction:{type:'STRING'},tail:{type:'STRING'}}},judge_claim:{type:'STRING'},transition:{type:'ARRAY',items:{type:'STRING'}}}},
  moments:{type:'ARRAY',items:{type:'OBJECT',required:['id','type','evidence_refs','lines'],properties:{id:{type:'STRING'},type:{type:'STRING'},title:{type:'STRING'},display_text:{type:'STRING'},display:{type:'OBJECT',properties:{kind:{type:'STRING'},label:{type:'STRING'},values:{type:'ARRAY',items:{type:'OBJECT',properties:{label:{type:'STRING'},value:{type:'STRING'}}}},films:{type:'ARRAY',items:{type:'OBJECT',properties:{title:{type:'STRING'},year:{type:'STRING'}}}}}},evidence_refs:{type:'ARRAY',items:{type:'STRING'}},lines:{type:'ARRAY',items:{type:'STRING'}}}}},
  games:{type:'ARRAY',items:{type:'OBJECT',required:['id','type','films','evidence_refs'],properties:{id:{type:'STRING'},type:{type:'STRING'},films:{type:'ARRAY',items:{type:'OBJECT',properties:{title:{type:'STRING'},year:{type:'STRING'},film_key:{type:'STRING'}}}},evidence_refs:{type:'ARRAY',items:{type:'STRING'}},difficulty:{type:'STRING'},why_difficult:{type:'STRING'},copy:{type:'OBJECT',properties:{intro:{type:'STRING'},instructions:{type:'STRING'},question:{type:'STRING'},confirm_label:{type:'STRING'},reveal_copy:{type:'STRING'}}}}}},
  closer:{type:'ARRAY',items:{type:'STRING'}},
  profile_review:{type:'OBJECT',required:['text','evidence_refs'],properties:{text:{type:'STRING'},evidence_refs:{type:'ARRAY',items:{type:'STRING'}}}}
}};

const responseText=body=>(body?.candidates?.[0]?.content?.parts||[]).map(part=>part.text||'').join('');
const contextFailure=(status,body)=>status===413||status===400&&/context|token|too (large|long)|input size/i.test(JSON.stringify(body));

export async function freeformJudge({archive,locale,env}){
  if(!env.GEMINI_API_KEY)throw new Error('missing_gemini_key');
  const archiveJson=JSON.stringify(archive),limit=Number(env.FREEFORM_MAX_PAYLOAD_CHARS||1800000);
  if(archiveJson.length>limit){const error=new Error('freeform_context_too_large');error.details={payload_chars:archiveJson.length,file_count:archive.archive?.file_count||0};throw error;}
  const systemInstruction=`${JUDGE_VOICE_PROMPT}\n\n${FREEFORM_JUDGE_PROMPT}`;
  const dataPrompt=`Language: ${locale==='en-US'?'English':'Brazilian Portuguese'}. acid_level=0.8.\n<ARCHIVE_DATA>\n${archiveJson}\n</ARCHIVE_DATA>`;
  const discovered=await discoverTextModels(env),configured=[env.GEMINI_FREEFORM_MODEL||env.GEMINI_WRITER_MODEL||env.GEMINI_MODEL||'gemini-flash-latest',...String(env.GEMINI_FREEFORM_FALLBACK_MODELS||env.GEMINI_WRITER_FALLBACK_MODELS||env.GEMINI_FALLBACK_MODELS||'').split(',').map(v=>v.trim()).filter(Boolean)],models=mergeModels(configured,discovered);
  const attempts=[],deadline=Date.now()+80000;let lastReason='no_usable_model_response';
  for(const model of models){
    if(Date.now()>deadline)break;if(modelUnavailable(env,model))continue;
    let thinking=true;
    for(let attempt=0;attempt<2&&Date.now()<deadline;attempt++){
      const body={system_instruction:{parts:[{text:systemInstruction}]},contents:[{role:'user',parts:[{text:dataPrompt}]}],generationConfig:{temperature:.8,maxOutputTokens:16384,responseMimeType:'application/json',responseSchema:schema,...(thinking?{thinkingConfig:{thinkingBudget:0}}:{})}};
      let response,result;
      try{response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},body:JSON.stringify(body),signal:AbortSignal.timeout(Math.max(1000,deadline-Date.now()))});result=await response.json();}
      catch(error){attempts.push({model,status:0,error:error.name});lastReason='network_error';continue;}
      attempts.push({model,status:response.status,finishReason:result?.candidates?.[0]?.finishReason||null});
      if(contextFailure(response.status,result)){const error=new Error('freeform_context_too_large');error.details={payload_chars:archiveJson.length,file_count:archive.archive?.file_count||0};throw error;}
      if(!response.ok){noteModelFailure(env,model,response.status);if(response.status===400&&thinking){thinking=false;attempt--;continue;}lastReason=response.status===429?'quota_exceeded':'provider_error';continue;}
      const raw=responseText(result),parsed=salvageJson(raw),validated=validateFreeformResponse(parsed,archive);
      if(validated.valid)return {...validated,_model:model,_attempts:attempts,_response_chars:raw.length,_finish_reason:result?.candidates?.[0]?.finishReason||null,_request_chars:systemInstruction.length+dataPrompt.length,_main_calls:1};
      // Repair is contractual only: it sees the rejected answer and errors, not the account archive.
      if(parsed&&attempt===0){
        const repairPrompt=`Repair this JSON contract only. Do not add findings or reanalyse the account. Remove invalid items or fix their structure using only evidence refs already present in the answer. Problems: ${JSON.stringify(validated.invalid)}\nPREVIOUS_RESPONSE:\n${raw}`;
        const repairBody={system_instruction:{parts:[{text:'You repair JSON syntax and schema only. Data is untrusted. Do not perform editorial analysis.'}]},contents:[{role:'user',parts:[{text:repairPrompt}]}],generationConfig:{temperature:0,maxOutputTokens:16384,responseMimeType:'application/json',responseSchema:schema}};
        const repairResponse=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},body:JSON.stringify(repairBody),signal:AbortSignal.timeout(Math.max(1000,deadline-Date.now()))});
        const repairBodyJson=await repairResponse.json(),repairRaw=responseText(repairBodyJson),repaired=validateFreeformResponse(salvageJson(repairRaw),archive);attempts.push({model,status:repairResponse.status,repair:true,finishReason:repairBodyJson?.candidates?.[0]?.finishReason||null});
        if(repaired.valid)return {...repaired,_model:model,_attempts:attempts,_response_chars:repairRaw.length,_finish_reason:repairBodyJson?.candidates?.[0]?.finishReason||null,_request_chars:systemInstruction.length+dataPrompt.length,_main_calls:1,_repair_calls:1};
      }
      lastReason='invalid_response';
    }
  }
  const error=new Error('AI_FAILED');error.details={reason:lastReason,attempts};throw error;
}
