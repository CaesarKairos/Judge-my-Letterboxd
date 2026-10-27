import {readFile} from 'node:fs/promises';
import {GROQ_CHAT_COMPLETIONS_URL,groqModels,groqText} from '../functions/_lib/groq.js';

async function localEnv(){
  const values={};
  for(const file of ['.dev.vars','.env'])try{
    const content=await readFile(new URL(`../${file}`,import.meta.url),'utf8');
    for(const line of content.split(/\r?\n/)){const match=line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(match&&!values[match[1]])values[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');}
  }catch{}
  return values;
}
const fileEnv=await localEnv(),env={...fileEnv,...process.env},key=env.GROQ_API_KEY;
if(!key||!/^gsk_[A-Za-z0-9]{40,}$/.test(key)){console.error(key?'GROQ_API_KEY tem formato inesperado; probe cancelado sem enviar credencial.':'GROQ_API_KEY ausente no ambiente, .dev.vars ou .env');process.exit(1);}
const models=groqModels(env),model=process.argv[2]||models[0];
const body={model,messages:[{role:'system',content:'Return exactly one valid JSON object and no other text.'},{role:'user',content:'Return {"ok":true}.'}],temperature:0,max_completion_tokens:64,response_format:{type:'json_object'}};
try{
  const response=await fetch(GROQ_CHAT_COMPLETIONS_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const result=await response.json().catch(()=>null),text=groqText(result);let jsonValid=false;try{const parsed=JSON.parse(text);jsonValid=!!parsed&&typeof parsed==='object'&&!Array.isArray(parsed);}catch{}
  const errorMessage=String(result?.error?.message||'');
  const failure=response.ok?(jsonValid?null:'invalid_json'):response.status===401||response.status===403?'invalid_api_key':response.status===429?/quota|billing|limit/i.test(errorMessage)?'quota_exceeded':'rate_limited':response.status>=500?'provider_error':'http_error';
  console.log(JSON.stringify({http_status:response.status,model,finish_reason:result?.choices?.[0]?.finish_reason||null,usage:result?.usage||null,json_valid:jsonValid,failure}));
  if(!response.ok||!jsonValid)process.exitCode=1;
}catch(error){console.log(JSON.stringify({http_status:0,model,failure:error?.name==='TimeoutError'?'timeout':'network_error'}));process.exitCode=1;}
