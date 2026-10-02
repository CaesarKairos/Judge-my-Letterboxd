import {unzip} from '../_lib/zip.js';
import {JUDGE_PIPELINE_MODE} from '../_lib/generated-mode.js';
import {runCurated} from '../_pipelines/curated.js';
import {runFreeform} from '../_pipelines/freeform.js';

const MAX_UPLOAD=50*1024*1024;
const response=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const statusFor=error=>({missing_gemini_key:503,gemini_rate_limit:429,invalid_zip:400,unsupported_zip:400,zip_too_many_files:400,zip_too_large:413,empty_export:422,not_letterboxd_export:422,gemini_invalid_response:502,analyst_unavailable:503,writer_unavailable:503,AI_FAILED:503,freeform_context_too_large:413}[error.message]||error.status||500);
const textEntries=entries=>{const decoder=new TextDecoder('utf-8',{fatal:false}),result=new Map();for(const [name,bytes] of entries)if(name.toLowerCase().endsWith('.csv'))result.set(name,decoder.decode(bytes));return result;};

export async function onRequestPost({request,env}){
  try{
    const runEnv=Object.create(env||null),length=Number(request.headers.get('Content-Length')||0);if(length>MAX_UPLOAD+1024*1024)return response({error:'file_too_large'},413);
    const form=await request.formData(),file=form.get('export'),locale=form.get('locale')==='en-US'?'en-US':'pt-BR';
    if(!file||typeof file.arrayBuffer!=='function')return response({error:'missing_export'},400);if(file.size>MAX_UPLOAD)return response({error:'file_too_large'},413);
    const header=new Uint8Array(await file.slice(0,4).arrayBuffer());if(header[0]!==80||header[1]!==75)return response({error:'invalid_zip'},400);
    const entries=await unzip(await file.arrayBuffer());
    // Test-only injection keeps both architectures testable in one Node process. Production has
    // no runtime override: generated-mode.js, synchronized from judge-mode.json, is authoritative.
    const mode=env?.__TEST_PIPELINE_MODE||JUDGE_PIPELINE_MODE;
    const result=mode==='freeform'?await runFreeform({entries,filename:file.name,locale,env:runEnv}):await runCurated({entries:textEntries(entries),locale,env:runEnv});
    return response(result);
  }catch(error){console.error('Judge pipeline failed',error.message);return response({error:error.message||'internal_error',...(error.details||{})},statusFor(error));}
}

export function onRequestGet(){return response({status:'ok',runtime:'cloudflare-pages',version:'web-v1',pipeline:JUDGE_PIPELINE_MODE});}
