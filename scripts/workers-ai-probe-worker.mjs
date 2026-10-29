import {workersAiText,workersAiFinishReason,workersAiResponsePath} from '../functions/_lib/workers-ai.js';
const MODELS=new Set(['@cf/openai/gpt-oss-120b','@cf/openai/gpt-oss-20b']);
export default {async fetch(request,env){
  const selected=new URL(request.url).searchParams.get('model'),MODEL=MODELS.has(selected)?selected:'@cf/openai/gpt-oss-120b';
  try{
    const result=await env.AI.run(MODEL,{messages:[
      {role:'system',content:'Reply with exactly one valid JSON object, without reasoning or Markdown. It must be {"ok":true}.'},
      {role:'user',content:'Return exactly {"ok":true}.'}
    ],temperature:0,max_tokens:256,response_format:{type:'json_object'}});
    const text=workersAiText(result);
    const first=result?.choices?.[0],message=first?.message;
    let jsonValid=false;try{const value=JSON.parse(text);jsonValid=!!value&&typeof value==='object'&&!Array.isArray(value);}catch{}
    return Response.json({http_status:200,model:MODEL,finish_reason:workersAiFinishReason(result),usage:result?.usage||null,response_shape:workersAiResponsePath(result),choice_keys:first?Object.keys(first).sort():[],message_keys:message&&typeof message==='object'?Object.keys(message).sort():[],message_content_type:typeof message?.content,message_content_array_length:Array.isArray(message?.content)?message.content.length:null,response_chars:text.length,json_valid:jsonValid,failure:jsonValid?null:'invalid_json'});
  }catch(error){
    const status=Number(error?.status||error?.code)||0,message=String(error?.message||'');
    const failure=/context|too many tokens|input.{0,12}(large|long)/i.test(message)?'context_exceeded':status===429?/quota|resource exhausted|billing/i.test(message)?'quota_exceeded':'rate_limited':status===400?'invalid_request':status===404?'model_unavailable':status>=500?'provider_error':/timeout|timed out|abort/i.test(message)?'timeout':'provider_error';
    return Response.json({http_status:status,model:MODEL,json_valid:false,failure});
  }
}};
