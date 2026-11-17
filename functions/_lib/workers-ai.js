// The 20b variant is Cloudflare's lower-latency GPT-OSS model. A full Letterboxd
// archive regularly makes the 120b model sit in the capacity queue until our request
// timeout, so reliability requires the fast model first and the larger model as the
// quality fallback.
export const AI_DEFAULT_MODEL='@cf/openai/gpt-oss-20b';
export const AI_DEFAULT_FALLBACK='@cf/openai/gpt-oss-120b';
export const GEMINI_DEFAULT_MODEL='gemini-3.8-flash';
export const GEMINI_DEFAULT_FALLBACK='gemini-3.1-flash-lite';
export const AI_MAX_MODELS=2;

export class WorkersAIError extends Error {
  constructor(message,details={}){super(message);this.name='WorkersAIError';this.details=details;}
}
export const workersAiModels=(env={},stage)=>{
  if(env.GEMINI_API_KEY){
    const primary=env[`GEMINI_${stage}_MODEL`]||env.GEMINI_MODEL||GEMINI_DEFAULT_MODEL;
    const fallback=String(env[`GEMINI_${stage}_FALLBACK_MODELS`]||env.GEMINI_FALLBACK_MODELS||GEMINI_DEFAULT_FALLBACK).split(',').map(x=>x.trim()).filter(Boolean);
    return [...new Set([primary,...fallback])].slice(0,AI_MAX_MODELS);
  }
  const primary=env[`AI_${stage}_MODEL`]||env.AI_MODEL||AI_DEFAULT_MODEL;
  const fallback=String(env[`AI_${stage}_FALLBACK_MODELS`]||env.AI_FALLBACK_MODELS||AI_DEFAULT_FALLBACK).split(',').map(x=>x.trim()).filter(Boolean);
  return [...new Set([primary,...fallback])].slice(0,AI_MAX_MODELS);
};
export const aiProvider=env=>env?.GEMINI_API_KEY?'gemini':'workers-ai';
export const aiConfigured=env=>Boolean(env?.GEMINI_API_KEY||(env?.AI&&typeof env.AI.run==='function'));
export const workersAiMessages=({system='',prompt=''})=>[
  {role:'system',content:`${system}\n\nReturn exactly one valid JSON object. (um único objeto JSON válido.) Do not include Markdown, code fences, or text before or after the object.`.trim()},
  {role:'user',content:prompt}
];
export const workersAiRequest=({system,prompt,temperature=.2,max_completion_tokens=8192})=>({
  messages:workersAiMessages({system,prompt}),temperature,max_tokens:max_completion_tokens,
  response_format:{type:'json_object'}
});
const contentText=value=>typeof value==='string'?value:Array.isArray(value)?value.map(item=>typeof item==='string'?item:typeof item?.text==='string'?item.text:typeof item?.content==='string'?item.content:'').join(''):'';
export const workersAiText=result=>contentText(result?.response)||contentText(result?.output_text)||contentText(result?.choices?.[0]?.message?.content)||contentText(result?.choices?.[0]?.text);
export const workersAiResponsePath=result=>contentText(result?.response)?'response':contentText(result?.output_text)?'output_text':contentText(result?.choices?.[0]?.message?.content)?'choices.message.content':contentText(result?.choices?.[0]?.text)?'choices.text':'missing';
export const workersAiFinishReason=result=>result?.finish_reason||result?.choices?.[0]?.finish_reason||null;
// Gemini 3 may return internal thought parts beside the final answer. Joining them makes
// valid JSON unreadable even though the provider returned HTTP 200.
const geminiText=result=>(result?.candidates?.[0]?.content?.parts||[]).filter(part=>part?.thought!==true).map(part=>part?.text||'').join('');
async function geminiRun({env,model,system,prompt,temperature,max_completion_tokens,signal}){
  const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',signal,headers:{'content-type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},body:JSON.stringify({systemInstruction:{parts:[{text:system}]},contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature,maxOutputTokens:max_completion_tokens,responseMimeType:'application/json'}})});
  const body=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(body?.error?.message||`Gemini HTTP ${response.status}`);error.status=response.status;throw error;}
  return {response:geminiText(body),finish_reason:body?.candidates?.[0]?.finishReason?.toLowerCase()||null,usage:body.usageMetadata};
}
export const classifyWorkersAiError=error=>{
  const status=Number(error?.status||error?.code)||0,message=String(error?.message||'');
  if(status===401||status===403||/api key|unauthenticated|permission denied/i.test(message))return 'invalid_api_key';
  if(error?.name==='TypeError'||/network|fetch failed/i.test(message))return 'network_error';
  if(/context|too many tokens|input.{0,12}(large|long)|maximum.{0,12}context/i.test(message))return 'context_exceeded';
  if(status===429||/quota|resource exhausted|billing/i.test(message))return /quota|resource exhausted|billing/i.test(message)?'quota_exceeded':'rate_limited';
  if(status===400)return 'invalid_request';
  if(status===404||/model.{0,12}(not found|unavailable)/i.test(message))return 'model_unavailable';
  if(status>=500)return 'provider_error';
  if(/timeout|timed out|abort/i.test(message))return 'timeout';
  return 'provider_error';
};

// The Pages AI binding returns model-specific objects (GPT-OSS exposes generated text in
// `response`), not OpenAI Chat Completions. This adapter is the only place that knows that.
export async function workersAiChat({env,model,system,prompt,temperature=.2,max_completion_tokens=8192,deadline=Date.now()+60000,timeoutMs=60000,phase='generation',maxTransientRetries=1}){
  if(!aiConfigured(env))throw new WorkersAIError('workers_ai_binding_missing',{reason:'binding_missing',phase,model});
  const attempts=[];
  for(let retry=0;retry<=maxTransientRetries;retry++){
    const remaining=deadline-Date.now();if(remaining<=0)throw new WorkersAIError('workers_ai_timeout',{reason:'timeout',phase,model,attempts});
    let timer;
    try{
      const controller=new AbortController();
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('AI call timed out'),{name:'TimeoutError'}));},Math.max(1,Math.min(timeoutMs,remaining)));});
      const call=env.GEMINI_API_KEY?geminiRun({env,model,system,prompt,temperature,max_completion_tokens,signal:controller.signal}):env.AI.run(model,workersAiRequest({system,prompt,temperature,max_completion_tokens}));
      const raw=await Promise.race([call,timeout]);
      const text=workersAiText(raw),finish_reason=workersAiFinishReason(raw);
      if(!text){attempts.push({model,status:200,phase,reason:'invalid_response',attempt:retry+1});throw new WorkersAIError('workers_ai_invalid_response',{reason:'invalid_response',phase,model,attempts});}
      const usage=raw?.usage||raw?.timings||undefined;
      attempts.push({model,status:200,phase,reason:'ok',attempt:retry+1,finish_reason,...(usage?{usage}:{})});
      return {text,finish_reason,usage,model,status:200,attempts,payload:raw};
    }catch(error){
      if(error instanceof WorkersAIError)throw error;
      const reason=error?.name==='TimeoutError'?'timeout':classifyWorkersAiError(error),status=Number(error?.status||error?.code)||0;
      attempts.push({model,status,...(status?{http:status}:{}),phase,reason,attempt:retry+1});
      // Retrying the same queued model after a timeout consumed the whole Freeform
      // deadline in production. Timeouts are model-specific availability failures: let
      // the fallback chain try a different model. Network errors and 5xx remain bounded
      // transient retries on the same model.
      if(retry<maxTransientRetries&&Date.now()<deadline&&['network_error','provider_error'].includes(reason))continue;
      throw new WorkersAIError(`workers_ai_${reason}`,{reason,phase,model,status,attempts});
    }finally{clearTimeout(timer);}
  }
}
export async function workersAiWithFallback({env,models=workersAiModels(env),maxTransientRetries=1,...request}){
  const allAttempts=[];let lastError;
  for(const model of models.slice(0,AI_MAX_MODELS)){
    try{const result=await workersAiChat({...request,env,model,maxTransientRetries});result.attempts=[...allAttempts,...result.attempts];return result;}
    catch(error){lastError=error;allAttempts.push(...(error.details?.attempts||[]));const reason=error.details?.reason;
      if(['invalid_api_key','invalid_request','context_exceeded','binding_missing'].includes(reason))break;
      if(!['rate_limited','quota_exceeded','provider_error','model_unavailable','timeout','network_error'].includes(reason))break;
    }
  }
  if(lastError){lastError.details={...lastError.details,attempts:allAttempts};throw lastError;}
  throw new WorkersAIError('workers_ai_model_unavailable',{reason:'model_unavailable',attempts:allAttempts});
}
