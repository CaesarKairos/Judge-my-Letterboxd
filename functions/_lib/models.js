const rejected=/embedding|embed|image|imagen|audio|speech|tts|veo|aqa/i;
const score=name=>{const value=name.toLowerCase();return (value.includes('flash')?100:0)+(value.includes('stable')?20:0)+(value.includes('latest')?15:0)-(value.includes('preview')?8:0)-(value.includes('lite')?25:0);};
// The Analyst and the Writer read the same catalogue. Discovery has to be wider than the
// longest chain, otherwise a stage would receive a list that was already cut to the other
// stage's size and half of the discovered backups would never be attempted.
export const DISCOVERY_LIMIT=12;
export const ANALYST_CHAIN_LIMIT=6;
export const WRITER_CHAIN_LIMIT=8;
export async function discoverTextModels(env){
  if(!env.GEMINI_API_KEY||env.GEMINI_MODEL_DISCOVERY==='0')return [];
  try{
    const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',{headers:{'x-goog-api-key':env.GEMINI_API_KEY},signal:AbortSignal.timeout(10000)});
    if(!response.ok)return [];
    const body=await response.json();
    return (body.models||[]).filter(model=>(model.supportedGenerationMethods||[]).includes('generateContent')).map(model=>String(model.name||'').replace(/^models\//,'')).filter(name=>name&&!rejected.test(name)).sort((a,b)=>score(b)-score(a)).slice(0,DISCOVERY_LIMIT);
  }catch{return [];}
}
const lite=name=>/lite/i.test(String(name||''));
// The primary model is always first, then explicit fallbacks, then the catalogue itself;
// Lite variants only run after everything else, so a cheap model never replaces a real one.
export const mergeModels=(configured=[],discovered=[],limit=WRITER_CHAIN_LIMIT)=>{
  const [primary,...explicit]=configured.filter(Boolean),dedupe=rows=>[...new Set(rows.filter(Boolean))];
  return dedupe([primary,...explicit.filter(name=>!lite(name)),...discovered.filter(name=>!lite(name)),...explicit.filter(lite),...discovered.filter(lite)]).slice(0,limit);
};
// A configured model that the catalogue does not list is reported, never silently trusted:
// 404 answers still remove it for the rest of the stage.
export const configuredWithoutDiscovery=(configured=[],discovered=[])=>discovered.length?configured.filter(name=>!discovered.includes(name)):[];
export const describeChain=chain=>chain.map((name,index)=>`${index+1}. ${name}`);
