// DEV-ONLY configuration diagnostics. The platform can report binding presence and the model
// chain without exposing secrets. Without
// JUDGE_DEBUG_CONFIG=1 the route behaves as if it did not exist, so a production deployment
// exposes nothing by accident: no key, no prompt, no environment dump.
import {mergeModels,MODEL_SAFETY_CEILING,FREEFORM_MODEL_LIMIT} from '../_lib/models.js';
import {workersAiModels} from '../_lib/workers-ai.js';

const response=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const configured=(env,stage)=>workersAiModels(env,stage==='FREEFORM'?undefined:stage);

export async function onRequestGet({env}){
  if(env.JUDGE_DEBUG_CONFIG!=='1')return response({error:'not_found'},404);
  const analyst=configured(env,'ANALYST'),writer=configured(env,'WRITER'),freeform=configured(env,'FREEFORM');
  return response({
    workers_ai_binding_present:Boolean(env.AI&&typeof env.AI.run==='function'),
    tmdb_key_present:Boolean(env.TMDB_API_KEY),
    model_discovery_enabled:false,
    primary_model:analyst[0],
    fallback_count:analyst.length-1,
    discovered_models:[],
    configured:{analyst,writer,freeform},
    chains:{analyst:mergeModels(analyst),writer:mergeModels(writer),freeform:mergeModels(freeform,[],FREEFORM_MODEL_LIMIT)},
    configured_without_discovery:[],
    limits:{chain:MODEL_SAFETY_CEILING,freeform_chain:FREEFORM_MODEL_LIMIT,discovery:0}
  });
}
