export const AI_DEFAULT_MODEL='@cf/openai/gpt-oss-120b';
export const AI_DEFAULT_FALLBACK='@cf/openai/gpt-oss-20b';
export const AI_MAX_MODELS=2;

export class WorkersAIError extends Error {
  constructor(message,details={}){super(message);this.name='WorkersAIError';this.details=details;}
}
export const workersAiModels=(env={},stage)=>{
  const primary=env[`AI_${stage}_MODEL`]||env.AI_MODEL||AI_DEFAULT_MODEL;
  const fallback=String(env[`AI_${stage}_FALLBACK_MODELS`]||env.AI_FALLBACK_MODELS||AI_DEFAULT_FALLBACK).split(',').map(x=>x.trim()).filter(Boolean);
  return [...new Set([primary,...fallback])].slice(0,AI_MAX_MODELS);
};
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
export const classifyWorkersAiError=error=>{
  const status=Number(error?.status||error?.code)||0,message=String(error?.message||'');
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
  if(!env?.AI||typeof env.AI.run!=='function')throw new WorkersAIError('workers_ai_binding_missing',{reason:'binding_missing',phase,model});
  const attempts=[];
  for(let retry=0;retry<=maxTransientRetries;retry++){
    const remaining=deadline-Date.now();if(remaining<=0)throw new WorkersAIError('workers_ai_timeout',{reason:'timeout',phase,model,attempts});
    let timer;
    try{
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('AI call timed out'),{name:'TimeoutError'})),Math.max(1,Math.min(timeoutMs,remaining)));});
      const raw=await Promise.race([env.AI.run(model,workersAiRequest({system,prompt,temperature,max_completion_tokens})),timeout]);
      const text=workersAiText(raw),finish_reason=workersAiFinishReason(raw);
      if(!text){attempts.push({model,status:200,phase,reason:'invalid_response',attempt:retry+1});throw new WorkersAIError('workers_ai_invalid_response',{reason:'invalid_response',phase,model,attempts});}
      const usage=raw?.usage||raw?.timings||undefined;
      attempts.push({model,status:200,phase,reason:'ok',attempt:retry+1,finish_reason,...(usage?{usage}:{})});
      return {text,finish_reason,usage,model,status:200,attempts,payload:raw};
    }catch(error){
      if(error instanceof WorkersAIError)throw error;
      const reason=error?.name==='TimeoutError'?'timeout':classifyWorkersAiError(error),status=Number(error?.status||error?.code)||0;
      attempts.push({model,status,...(status?{http:status}:{}),phase,reason,attempt:retry+1});
      if(retry<maxTransientRetries&&Date.now()<deadline&&['timeout','network_error','provider_error'].includes(reason))continue;
      throw new WorkersAIError(`workers_ai_${reason}`,{reason,phase,model,status,attempts});
    }finally{clearTimeout(timer);}
  }
}
export async function workersAiWithFallback({env,models=workersAiModels(env),maxTransientRetries=1,...request}){
  const allAttempts=[];let lastError;
  for(const model of models.slice(0,AI_MAX_MODELS)){
    try{const result=await workersAiChat({...request,env,model,maxTransientRetries});result.attempts=[...allAttempts,...result.attempts];return result;}
    catch(error){lastError=error;allAttempts.push(...(error.details?.attempts||[]));const reason=error.details?.reason;
      if(['invalid_request','timeout','context_exceeded','binding_missing'].includes(reason))break;
      if(!['rate_limited','quota_exceeded','provider_error','model_unavailable'].includes(reason))break;
    }
  }
  if(lastError){lastError.details={...lastError.details,attempts:allAttempts};throw lastError;}
  throw new WorkersAIError('workers_ai_model_unavailable',{reason:'model_unavailable',attempts:allAttempts});
}
