export const GROQ_CHAT_COMPLETIONS_URL='https://api.groq.com/openai/v1/chat/completions';
export const GROQ_DEFAULT_MODEL='openai/gpt-oss-120b';
export const GROQ_DEFAULT_FALLBACK='openai/gpt-oss-20b';
export const GROQ_MAX_MODELS=2;

export class GroqError extends Error {
  constructor(message,details={}){super(message);this.name='GroqError';this.details=details;}
}
export const groqModels=(env={},stage)=>{
  const primary=env[`GROQ_${stage}_MODEL`]||env.GROQ_MODEL||GROQ_DEFAULT_MODEL;
  const fallback=String(env[`GROQ_${stage}_FALLBACK_MODELS`]||env.GROQ_FALLBACK_MODELS||GROQ_DEFAULT_FALLBACK).split(',').map(x=>x.trim()).filter(Boolean);
  return [...new Set([primary,...fallback])].slice(0,GROQ_MAX_MODELS);
};
export const groqMessages=({system='',prompt=''})=>[
  {role:'system',content:`${system}\n\nReturn exactly one valid JSON object. (um único objeto JSON válido.) Do not include Markdown, code fences, or text before or after the object.`.trim()},
  {role:'user',content:prompt}
];
export const groqRequestBody=({model,system,prompt,temperature=.2,max_completion_tokens=8192})=>({
  model,messages:groqMessages({system,prompt}),temperature,max_completion_tokens,response_format:{type:'json_object'}
});
export const groqText=body=>typeof body?.choices?.[0]?.message?.content==='string'?body.choices[0].message.content:'';
export const groqFinishReason=body=>body?.choices?.[0]?.finish_reason||null;
export const groqErrorKind=(status,body)=>{
  if(status===401||status===403)return 'invalid_api_key';
  if(status===400)return 'invalid_request';
  if(status===404)return /model/i.test(String(body?.error?.message||''))?'model_unavailable':'provider_not_found';
  if(status===429)return /quota|billing|limit.*day|resource_exhausted/i.test(`${body?.error?.status||''} ${body?.error?.message||''} ${body?.error?.code||''}`)?'quota_exceeded':'rate_limited';
  if(status>=500)return 'provider_error';
  return 'provider_error';
};
const safeMessage=body=>String(body?.error?.message||'').replace(/Bearer\s+\S+/ig,'Bearer [redacted]').slice(0,180);

// Retry one transient network/5xx failure once on the same model; 429 advances directly to
// the single configured fallback. 400/auth failures never repeat. Caller controls the budget.
export async function groqChat({env,model,system,prompt,temperature=.2,max_completion_tokens=8192,deadline=Date.now()+60000,timeoutMs=60000,phase='generation',maxTransientRetries=1}){
  if(!env?.GROQ_API_KEY)throw new GroqError('missing_groq_key',{reason:'missing_groq_key',phase,model});
  const body=groqRequestBody({model,system,prompt,temperature,max_completion_tokens}),attempts=[];
  for(let retry=0;retry<=maxTransientRetries;retry++){
    const remaining=deadline-Date.now();if(remaining<=0)throw new GroqError('groq_timeout',{reason:'timeout',phase,model,attempts});
    let response,payload;
    try{
      response=await fetch(GROQ_CHAT_COMPLETIONS_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.GROQ_API_KEY}`},body:JSON.stringify(body),signal:AbortSignal.timeout(Math.max(1,Math.min(timeoutMs,remaining)))});
      payload=await response.json().catch(()=>null);
    }catch(error){
      const reason=error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'network_error';
      attempts.push({model,status:0,phase,reason,attempt:retry+1});
      if(retry<maxTransientRetries&&Date.now()<deadline)continue;
      throw new GroqError(reason==='timeout'?'groq_timeout':'groq_network_error',{reason,phase,model,attempts});
    }
    const usage=payload?.usage?{prompt_tokens:payload.usage.prompt_tokens,completion_tokens:payload.usage.completion_tokens,total_tokens:payload.usage.total_tokens}:undefined;
    if(!response.ok){
      const reason=groqErrorKind(response.status,payload),entry={model,status:response.status,http:response.status,phase,reason,attempt:retry+1,...(usage?{usage}:{})};attempts.push(entry);
      if(response.status>=500&&retry<maxTransientRetries&&Date.now()<deadline)continue;
      throw new GroqError(`groq_${reason}`,{...entry,attempts,provider_message:safeMessage(payload)});
    }
    const text=groqText(payload),finish_reason=groqFinishReason(payload);
    attempts.push({model,status:response.status,phase,reason:'ok',attempt:retry+1,finish_reason,...(usage?{usage}:{})});
    return {text,finish_reason,usage,model,status:response.status,attempts,payload};
  }
}

export async function groqWithFallback({env,models=groqModels(env),maxTransientRetries=1,...request}){
  const allAttempts=[];let lastError;
  for(const model of models.slice(0,GROQ_MAX_MODELS)){
    try{const result=await groqChat({...request,env,model,maxTransientRetries});result.attempts=[...allAttempts,...result.attempts];return result;}
    catch(error){lastError=error;allAttempts.push(...(error.details?.attempts||[]));const reason=error.details?.reason||error.details?.attempts?.at(-1)?.reason;
      if(['invalid_api_key','invalid_request','timeout','network_error'].includes(reason))break;
      if(!['rate_limited','quota_exceeded','provider_error','model_unavailable','provider_not_found'].includes(reason))break;
    }
  }
  if(lastError){lastError.details={...lastError.details,attempts:allAttempts};throw lastError;}
  throw new GroqError('groq_model_unavailable',{reason:'model_unavailable',attempts:allAttempts});
}
