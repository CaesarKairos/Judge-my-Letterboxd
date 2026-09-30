const rejected=/embedding|embed|image|imagen|audio|speech|tts|veo|aqa/i;
const score=name=>{const value=name.toLowerCase();return (value.includes('flash')?100:0)+(value.includes('stable')?20:0)+(value.includes('latest')?15:0)-(value.includes('preview')?8:0)-(value.includes('lite')?25:0);};
export async function discoverTextModels(env){
  if(!env.GEMINI_API_KEY||env.GEMINI_MODEL_DISCOVERY==='0')return [];
  try{
    const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',{headers:{'x-goog-api-key':env.GEMINI_API_KEY},signal:AbortSignal.timeout(10000)});
    if(!response.ok)return [];
    const body=await response.json();
    return (body.models||[]).filter(model=>(model.supportedGenerationMethods||[]).includes('generateContent')).map(model=>String(model.name||'').replace(/^models\//,'')).filter(name=>name&&!rejected.test(name)).sort((a,b)=>score(b)-score(a)).slice(0,6);
  }catch{return [];}
}
const lite=name=>/lite/i.test(String(name||''));
export const mergeModels=(configured=[],discovered=[])=>{
  const [primary,...explicit]=configured.filter(Boolean),dedupe=rows=>[...new Set(rows.filter(Boolean))];
  return dedupe([primary,...explicit.filter(name=>!lite(name)),...discovered.filter(name=>!lite(name)),...explicit.filter(lite),...discovered.filter(lite)]).slice(0,8);
};
