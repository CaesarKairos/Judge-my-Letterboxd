import {unzipText} from '../_lib/zip.js';
import {parseExport,analyzeExport} from '../_lib/letterboxd.js';
import {writeJudgment} from '../_lib/gemini.js';
import {buildPresentation} from '../_lib/judge.js';
import {selectEditorialMoments} from '../_lib/analyst.js';
import {buildRawExport} from '../_lib/raw-export.js';
import {materializeCandidates,buildScriptEngine,callbackCandidates,selectInteractions} from '../_lib/editorial.js';
import {enrichGameInteractions} from '../_lib/tmdb-games.js';

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
    const profile=parseExport(entries),analysis=analyzeExport(profile,locale),raw_export=buildRawExport(entries);
    console.log('ZIP parsed:',raw_export.file_count,'files');
    console.log('Analysis:',profile.reviews.length,'reviews,',analysis.overview.tags||0,'tags,',profile.lists.length,'lists,',analysis.relationships?.relations?.length||0,'relationships');
    if(!profile.films.length)return response({error:'empty_export'},422);
    if(!env.GEMINI_API_KEY)return response({error:'missing_gemini_key',retryable:true,deterministic_analysis_available:true,analysis:{stats:analysis.stats,overview:analysis.overview}},503);
    const analyst=await selectEditorialMoments({profile,analysis,raw_export,locale,env});
    console.log('Analyst:',analyst.model||'none',analyst.status,analyst.candidate_count,'candidates,',analyst.selected.length,'accepted |',
      'top_four_semantics',analyst.top_four_semantics_status,'| editorial',analyst.editorial_strength||'empty');
    // A failed Analyst still means no session: deterministic candidates never pretend to be a
    // judgment. A thin Analyst is a real analysis and continues, with a shorter material pool.
    if(analyst.status==='failed')return response({error:'analyst_unavailable',stage:'analyst',reason:analyst.reason||'no_usable_analysis',retryable:true,
      deterministic_analysis_available:true,attempts:analyst.attempts||[],
      generation_meta:{analyst:{status:'failed',reason:analyst.reason||null,attempts:analyst.attempts||[],chain:analyst.chain||[]}},
      analysis:{stats:analysis.stats,overview:analysis.overview}},503);
    const materialized=materializeCandidates(analyst.selected,analysis.moments);
    analysis.moments=buildScriptEngine(materialized,profile.reviews.length);
    analysis.interactions=await enrichGameInteractions(selectInteractions(analyst.interaction_candidates||[],profile),env,locale);
    analysis.top_four_semantics=analyst.top_four_semantics||[];
    analysis.callbacks=callbackCandidates(analysis.moments);
    console.log('Script:',analysis.moments.length,'moments |','Writer called: true');
    const writing=await writeJudgment({profile,analysis,locale,env});
    console.log('Writer:',writing.generation_status||'complete',writing._model||'none',(writing.reactions||[]).length+'/'+analysis.moments.length,'reactions','archetype',Boolean(writing.archetype_phrase),'profile_review',Boolean(writing.profile_review?.text));
    if(writing.generation_status==='failed')return response({error:'writer_unavailable',stage:'writer',reason:'no_usable_model_response',retryable:true,
      attempts:writing._attempts||[],deterministic_analysis_available:true,
      generation_meta:{writer:{status:'failed',attempts:writing._attempts||[]}},
      analysis:{stats:analysis.stats,overview:analysis.overview}},503);
    console.log('Presentation:',writing.generation_status||'complete');
    return response(buildPresentation({profile,analysis,writing,locale,analyst}));
  }catch(error){
    console.error('Judge pipeline failed',error.message);
    return response({error:error.message||'internal_error'},statusFor(error));
  }
}

export function onRequestGet(){return response({status:'ok',runtime:'cloudflare-pages',version:'web-v1'});}
