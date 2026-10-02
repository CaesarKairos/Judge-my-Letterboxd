import {parseExport,analyzeExport} from '../_lib/letterboxd.js';
import {writeJudgment} from '../_lib/gemini.js';
import {buildPresentation} from '../_lib/judge.js';
import {selectEditorialMoments} from '../_lib/analyst.js';
import {buildRawExport} from '../_lib/raw-export.js';
import {buildEditorialSelection,callbackCandidates} from '../_lib/editorial.js';
import {enrichGameInteractions} from '../_lib/tmdb-games.js';

export async function runCurated({entries,locale,env}){
  const profile=parseExport(entries),analysis=analyzeExport(profile,locale),raw_export=buildRawExport(entries);
  if(!profile.films.length){const error=new Error('empty_export');error.status=422;throw error;}
  if(!env.GEMINI_API_KEY){const error=new Error('missing_gemini_key');error.details={retryable:true,deterministic_analysis_available:true,analysis:{stats:analysis.stats,overview:analysis.overview}};throw error;}
  const analyst=await selectEditorialMoments({profile,analysis,raw_export,locale,env});
  if(analyst.status==='failed'){const error=new Error('analyst_unavailable');error.status=503;error.details={stage:'analyst',reason:analyst.reason||'no_usable_analysis',retryable:true,deterministic_analysis_available:true,attempts:analyst.attempts||[],generation_meta:{analyst:{status:'failed',reason:analyst.reason||null,attempts:analyst.attempts||[],chain:analyst.chain||[]}},analysis:{stats:analysis.stats,overview:analysis.overview}};throw error;}
  const editorial=buildEditorialSelection({profile,analysis,analyst,pool:analyst.interaction_pool||[],richness:profile.reviews.length});analysis.moments=editorial.moments;analysis.interactions=await enrichGameInteractions(editorial.interactions,env,locale);analysis.top_four_semantics=analyst.top_four_semantics||[];analysis.callbacks=callbackCandidates(analysis.moments);
  const writing=await writeJudgment({profile,analysis,locale,env});
  if(writing.generation_status==='failed'){const error=new Error('writer_unavailable');error.status=503;error.details={stage:'writer',reason:writing.reason||'no_usable_model_response',retryable:true,attempts:writing._attempts||[],deterministic_analysis_available:true,generation_meta:{writer:{status:'failed',attempts:writing._attempts||[]}},analysis:{stats:analysis.stats,overview:analysis.overview}};throw error;}
  const presentation=buildPresentation({profile,analysis,writing,locale,analyst});presentation.pipeline_mode='curated';presentation.generation_meta={...presentation.generation_meta,pipeline:'curated'};return presentation;
}
