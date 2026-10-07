// Text capabilities the Judge does not use, plus families that cannot honour the structured
// output contract we send (Gemma does not accept responseMimeType/responseSchema): keeping them
// out of the chain is cheaper than discovering the incompatibility with a 400 at runtime.
const rejected=/embedding|embed|image|imagen|audio|speech|tts|veo|aqa|lyria|transcribe|robotics|computer-use|antigravity|deep-research|nano-banana|gemma|(^|-)(live|native-audio)(-|$)/i;
const lite=name=>/lite/i.test(String(name||''));
const preview=name=>/preview|experimental|-exp(-|$)/i.test(String(name||''));
const generation=name=>{const match=/^gemini-(\d+)(?:\.(\d+))?/.exec(String(name||''));return match?Number(match[1])*100+(Number(match[2])||0):0;};

// The chain is a quality ladder, never a fixed list:
//   1. the configured primary (always first);
//   2. complete Flash models from the catalogue, newest generation first;
//   3. other compatible textual models;
//   4. compatible previews;
//   5. Flash-Lite only after every complete model, even when explicitly configured.
export const modelTier=name=>lite(name)?0:preview(name)?1:/flash/i.test(name)?3:2;
export const modelScore=(name,explicit=false)=>modelTier(name)*10000+generation(name)*10+(String(name).includes('latest')?4:0)+(explicit?2:0);

// Discovery is the main source of fallbacks, so it must not cut the list before the last
// candidate: the deadline decides how many of them actually run.
export const DISCOVERY_LIMIT=20;
// Safety ceiling only, for a runaway loop; a stage is limited by its deadline, not by a count.
export const MODEL_SAFETY_CEILING=24;
// Freeform requests carry the complete archive. Keep this chain deliberately small: discovery
// ranks candidates, but does not make twenty expensive probes appropriate for one session.
export const FREEFORM_MODEL_LIMIT=4;
export async function discoverTextModels(env){
  if(!env.GEMINI_API_KEY||env.GEMINI_MODEL_DISCOVERY==='0')return [];
  try{
    const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',{headers:{'x-goog-api-key':env.GEMINI_API_KEY},signal:AbortSignal.timeout(10000)});
    if(!response.ok)return [];
    const body=await response.json();
    return (body.models||[]).filter(model=>(model.supportedGenerationMethods||[]).includes('generateContent'))
      .map(model=>String(model.name||'').replace(/^models\//,'')).filter(name=>name&&!rejected.test(name))
      .sort((a,b)=>modelScore(b)-modelScore(a)||a.localeCompare(b)).slice(0,DISCOVERY_LIMIT);
  }catch{return [];}
}

// The primary stays first; everything else (explicit fallbacks and the catalogue) is ranked by
// the ladder. Explicit configuration is a tiebreak inside a tier, never a way for a deprecated or
// Lite model to jump ahead of a complete Flash model that discovery confirmed.
export const mergeModels=(configured=[],discovered=[],limit=MODEL_SAFETY_CEILING)=>{
  const explicit=[...new Set(configured.filter(Boolean))],all=[...new Set([...explicit,...discovered.filter(Boolean)])];
  const ordered=all.map(name=>({name,score:modelScore(name,explicit.includes(name))}))
    .sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).map(row=>row.name);
  const primary=explicit[0]||ordered[0];
  return [primary,...ordered.filter(name=>name!==primary)].slice(0,limit);
};
// A configured model that the catalogue does not list is reported, never silently trusted:
// 404 answers still remove it for the rest of the stage.
export const configuredWithoutDiscovery=(configured=[],discovered=[])=>discovered.length?configured.filter(name=>!discovered.includes(name)):[];
export const describeChain=chain=>chain.map((name,index)=>`${index+1}. ${name}`);

// A model that just answered 404 (or 429) is not worth another call inside the same pipeline run:
// the Analyst and the Writer share this registry through env, so the second stage does not pay
// for the same dead model again. It is per request and never persisted.
const RUN_KEY='__MODEL_RUN_UNAVAILABLE';
export const modelRunRegistry=env=>{if(!env)return new Set();if(!(env[RUN_KEY]instanceof Set))env[RUN_KEY]=new Set();return env[RUN_KEY];};
export const noteModelFailure=(env,model,response)=>{if([404,429].includes(Number(response)))modelRunRegistry(env).add(model);};
export const modelUnavailable=(env,model)=>modelRunRegistry(env).has(model);

