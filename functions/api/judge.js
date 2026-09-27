import {unzipText} from '../_lib/zip.js';
import {parseExport,analyzeExport} from '../_lib/letterboxd.js';
import {writeJudgment} from '../_lib/gemini.js';
import {buildPresentation} from '../_lib/judge.js';

const MAX_UPLOAD=50*1024*1024;
const response=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const statusFor=error=>({missing_gemini_key:503,gemini_rate_limit:429,invalid_zip:400,unsupported_zip:400,zip_too_many_files:400,zip_too_large:413,not_letterboxd_export:422,gemini_invalid_response:502}[error.message]||error.status||500);

export async function onRequestPost({request,env}) {
  try{
    const length=Number(request.headers.get('Content-Length')||0);if(length>MAX_UPLOAD+1024*1024)return response({error:'file_too_large'},413);
    const form=await request.formData(),file=form.get('export'),locale=form.get('locale')==='en-US'?'en-US':'pt-BR';
    if(!file||typeof file.arrayBuffer!=='function')return response({error:'missing_export'},400);
    if(file.size>MAX_UPLOAD)return response({error:'file_too_large'},413);
    const header=new Uint8Array(await file.slice(0,4).arrayBuffer());if(header[0]!==80||header[1]!==75)return response({error:'invalid_zip'},400);
    const entries=await unzipText(await file.arrayBuffer());
    const profile=parseExport(entries),analysis=analyzeExport(profile,locale);
    if(!profile.films.length)return response({error:'empty_export'},422);
    const writing=await writeJudgment({profile,analysis,locale,env});
    return response(buildPresentation({profile,analysis,writing,locale}));
  }catch(error){
    console.error('Judge pipeline failed',error.message);
    return response({error:error.message||'internal_error'},statusFor(error));
  }
}

export function onRequestGet(){return response({status:'ok',runtime:'cloudflare-pages',version:'web-v1'});}
