// DEV-ONLY configuration diagnostics. The platform can answer "is the key present, which model
// would serve, what did discovery return?" without ever echoing a secret. Without
// JUDGE_DEBUG_CONFIG=1 the route behaves as if it did not exist, so a production deployment
// exposes nothing by accident: no key, no prompt, no environment dump.
import {discoverTextModels,mergeModels,configuredWithoutDiscovery,ANALYST_CHAIN_LIMIT,WRITER_CHAIN_LIMIT} from '../_lib/models.js';

const response=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const configured=(env,stage)=>[env[`GEMINI_${stage}_MODEL`]||env.GEMINI_MODEL||'gemini-flash-latest',
  ...String(env[`GEMINI_${stage}_FALLBACK_MODELS`]||env.GEMINI_FALLBACK_MODELS||'').split(',').map(value=>value.trim()).filter(Boolean)];

export async function onRequestGet({env}){
  if(env.JUDGE_DEBUG_CONFIG!=='1')return response({error:'not_found'},404);
  const discovered=await discoverTextModels(env),analyst=configured(env,'ANALYST'),writer=configured(env,'WRITER');
  return response({
    gemini_key_present:Boolean(env.GEMINI_API_KEY),
    tmdb_key_present:Boolean(env.TMDB_API_KEY),
    model_discovery_enabled:env.GEMINI_MODEL_DISCOVERY!=='0',
    primary_model:analyst[0],
    fallback_count:analyst.length-1,
    discovered_models:discovered,
    configured:{analyst,writer},
    chains:{analyst:mergeModels(analyst,discovered,ANALYST_CHAIN_LIMIT),writer:mergeModels(writer,discovered,WRITER_CHAIN_LIMIT)},
    configured_without_discovery:configuredWithoutDiscovery([...new Set([...analyst,...writer])],discovered),
    limits:{analyst:ANALYST_CHAIN_LIMIT,writer:WRITER_CHAIN_LIMIT}
  });
}
