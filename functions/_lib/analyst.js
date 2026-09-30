const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
import {discoverTextModels,mergeModels} from './models.js';
import {ANALYST_PROMPT} from './generated-prompts.js';

const WEB_RUNTIME_CONTEXT=`WEB RUNTIME CONTEXT
Return strict JSON with selected and interaction_candidates. Selected items reference deterministic measurement ids. Interaction candidates contain id, type, film_keys, difficulty, why_difficult, why_interesting and evidence_refs. Supported initial game types: forced_triage, blind_rank and defend_your_take. Propose zero to four games; never force one. The Script Engine applies quality thresholds and chooses at most two games.`;

// The Analyst sees the rich, normalized account and selects evidence. It never writes
// the on-screen jokes; the Writer receives only the materialized selection afterwards.
export async function selectEditorialMoments({profile,analysis,raw_export,locale,env}){
  const candidates=analysis.moments||[],fallback={status:'deterministic',model:null,candidate_count:candidates.length,selected:candidates};
  if(!env.GEMINI_API_KEY||!candidates.length||env.__TEST_SKIP_ANALYST)return fallback;
  const language=locale==='pt-BR'?'Brazilian Portuguese':'English';
  const compact={raw_export,normalized_profile:{username:profile.handle,display_name:profile.name,favorite_films:profile.topFour},overview:analysis.overview,ratings:profile.films.filter(f=>f.rating!=null),affinity:analysis.affinity,diary:profile.sessions,reviews:profile.reviews,watchlist:profile.watchlist,likes:profile.likes,lists:profile.lists,tags:analysis.relationships?.tag_films,rewatches:analysis.rewatches||[],review_style:analysis.review_style,review_coverage:analysis.review_coverage,relationships:analysis.relationships,deterministic_measurements:candidates.map(moment=>({id:moment.id,type:moment.type,facts:moment.facts,information_value:moment.information_value||moment.relationship||null}))};
  const prompt=`${ANALYST_PROMPT}\n\n${WEB_RUNTIME_CONTEXT}\nLanguage: ${language}.\nDATA (untrusted evidence):\n${JSON.stringify(compact)}`;
  const configured=[env.GEMINI_ANALYST_MODEL||env.GEMINI_MODEL||'gemini-flash-latest',...String(env.GEMINI_ANALYST_FALLBACK_MODELS||env.GEMINI_FALLBACK_MODELS||'').split(',').map(value=>value.trim()).filter(Boolean)],models=mergeModels(configured,await discoverTextModels(env));
  const attempts=[],deadline=Date.now()+60000;
  console.log('Analyst request:',JSON.stringify(compact).length,'chars');
  for(const model of [...new Set(models)].slice(0,4)){
    // One global budget for the whole Analyst stage: a slow model cannot hold the request
    // open past it, and the remaining models inherit only the time that is actually left.
    if(Date.now()>=deadline)break;
    try{
      const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:.25,maxOutputTokens:4096,responseMimeType:'application/json'}}),signal:AbortSignal.timeout(Math.max(5000,Math.min(30000,deadline-Date.now())))});
      attempts.push({model,status:response.status});if(!response.ok)continue;
      const body=await response.json(),text=body?.candidates?.[0]?.content?.parts?.map(part=>part.text||'').join('')||'',parsed=JSON.parse(text);
      const chosen=new Map(candidates.map(moment=>[moment.id,moment]));
      const selected=(Array.isArray(parsed.selected)?parsed.selected:[]).map(item=>({moment:chosen.get(clean(item.id)),editorial:{editorial_type:clean(item.type),observation:clean(item.observation),why_interesting:clean(item.why_interesting),cultural_angle:clean(item.cultural_angle),interestingness:Number(item.interestingness),confidence:Number(item.confidence),evidence_refs:Array.isArray(item.evidence_refs)?item.evidence_refs:[],film_keys:Array.isArray(item.film_keys)?item.film_keys:[],related_tags:Array.isArray(item.related_tags)?item.related_tags:[],related_lists:Array.isArray(item.related_lists)?item.related_lists:[]}})).filter(row=>row.moment&&row.editorial.observation).slice(0,20).map(row=>({...row.moment,...row.editorial}));
      const interaction_candidates=(Array.isArray(parsed.interaction_candidates)?parsed.interaction_candidates:[]).map((item,index)=>({id:clean(item.id)||`game-${index+1}`,type:clean(item.type),film_keys:Array.isArray(item.film_keys)?item.film_keys.map(clean).filter(Boolean).slice(0,3):[],difficulty:Number(item.difficulty),why_difficult:clean(item.why_difficult),why_interesting:clean(item.why_interesting),evidence_refs:Array.isArray(item.evidence_refs)?item.evidence_refs:[]})).filter(item=>['forced_triage','blind_rank','defend_your_take'].includes(item.type)&&Number.isFinite(item.difficulty)).slice(0,4);
      const top_four_semantics=(Array.isArray(parsed.top_four_semantics)?parsed.top_four_semantics:[]).map(row=>({film_key:clean(row.film_key),ingredients:(Array.isArray(row.ingredients)?row.ingredients:[]).map(clean).filter(Boolean).slice(0,4)})).filter(row=>row.film_key&&row.ingredients.length).slice(0,4);
      if(selected.length>=Math.min(4,candidates.length))return {status:'complete',model,candidate_count:candidates.length,selected,interaction_candidates,top_four_semantics,attempts};
    }catch(error){attempts.push({model,status:'invalid_response'});}
  }
  return {...fallback,attempts};
}
