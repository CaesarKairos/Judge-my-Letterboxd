import {readFile} from 'node:fs/promises';
import {freeformResponseSchema as schema} from '../functions/_lib/freeform/judge.js';

const localEnv=async()=>{try{return Object.fromEntries((await readFile('.env','utf8')).split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#')&&line.includes('=')).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));}catch{return {};}};
const env={...(await localEnv()),...process.env},key=env.GEMINI_API_KEY;
if(!key){console.error('GEMINI_API_KEY is not available in the environment or .env');process.exitCode=1;}

const stages=[
  ['minimal',{}],
  ['system instruction',{system_instruction:{parts:[{text:'Return strict JSON only.'}]}}],
  ['json mime',{system_instruction:{parts:[{text:'Return strict JSON only.'}]},generationConfig:{responseMimeType:'application/json'}}],
  ['response schema',{system_instruction:{parts:[{text:'Return strict JSON only.'}]},generationConfig:{responseMimeType:'application/json',responseSchema:schema}}],
  ['thinking',model=>{const thinkingConfig=/^gemini-3(?:\.|-)/.test(model)?{thinkingLevel:'low'}:/^gemini-2\.5-flash(?:-|$)/.test(model)?{thinkingBudget:0}:null;return thinkingConfig?{system_instruction:{parts:[{text:'Return strict JSON only.'}]},generationConfig:{responseMimeType:'application/json',responseSchema:schema,thinkingConfig}}:null;}]
];
const models=process.argv.slice(2).length?process.argv.slice(2):['gemini-3.8-flash','gemini-flash-latest'];
const clean=value=>JSON.parse(JSON.stringify(value));
if(key)for(const model of models){
  console.log(`MODEL ${model}`);
  for(const [label,extraValue] of stages){
    const extra=typeof extraValue==='function'?extraValue(model):extraValue;if(extra===null){console.log(`${label.padEnd(21,'.')} SKIP unknown model family`);continue;}const body=clean({contents:[{role:'user',parts:[{text:'Return {"ok":true}.'}]}],...extra});
    try{const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)}),result=await response.json();const diagnostic=response.ok?'OK':`${result?.error?.status||'ERROR'} code=${result?.error?.code??response.status}`;console.log(`${label.padEnd(21,'.')} ${response.status} ${diagnostic}`);}catch(error){console.log(`${label.padEnd(21,'.')} 0 ${error.name}`);}
  }
}
