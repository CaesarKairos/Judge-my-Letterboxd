const TYPE_ORDER=['writing_pattern','semantic_contrast','rewatch_pattern','tag_list_relationship','list_meaning','tag_meaning','review_spotlight','logging_behavior','favorite_behavior','exception','temporal_pattern','relationship'];
const family=moment=>({phrase:'writing',review_quote:'review',film_pair:'rating',rewatch:'rewatch',tag:moment.relationship?'relationship':'tag',list:'list'}[moment.type]||moment.type);

export function materializeCandidates(candidates,deterministic){
  const byId=new Map(deterministic.map(moment=>[moment.id,moment]));
  return candidates.map(candidate=>{
    const base=byId.get(candidate.id);if(!base)return null;
    return {...base,editorial_type:candidate.editorial_type||base.type,observation:candidate.observation||'',why_interesting:candidate.why_interesting||'',cultural_angle:candidate.cultural_angle||'',interestingness:Number.isFinite(candidate.interestingness)?candidate.interestingness:.5,confidence:Number.isFinite(candidate.confidence)?candidate.confidence:.7};
  }).filter(Boolean);
}

export function buildScriptEngine(moments,richness=0){
  const target=richness>=100?16:richness>=35?14:10,ranked=[...moments].sort((a,b)=>(b.interestingness||0)-(a.interestingness||0));
  const selected=[],used=new Set(),usage=new Map();
  const take=moment=>{selected.push(moment);used.add(moment.id);usage.set(family(moment),(usage.get(family(moment))||0)+1);};
  // First pass creates variety: one moment per wanted family before any family repeats.
  for(const wanted of TYPE_ORDER)for(const moment of ranked)if(!used.has(moment.id)&&(moment.editorial_type===wanted||family(moment)===wanted)){take(moment);break;}
  // Second pass fills up to the target and balances the remaining slots by family, so a review
  // spotlight or a temporal measurement is not crowded out by ten tag beats. A rich account must
  // not stop at six observations just because the strongest candidates share a family.
  let guard=ranked.length;
  while(selected.length<target&&guard-->0){
    const previousFamily=selected.length?family(selected.at(-1)):null;
    const pool=ranked.filter(moment=>!used.has(moment.id));
    if(!pool.length)break;
    const fresh=pool.filter(moment=>family(moment)!==previousFamily);
    const candidates=(fresh.length?fresh:pool).sort((a,b)=>(usage.get(family(a))||0)-(usage.get(family(b))||0));
    take(candidates[0]);
  }
  return selected.slice(0,Math.min(18,target));
}

export function callbackCandidates(moments){
  const callbacks=[];for(let index=0;index<moments.length;index++)for(let later=index+1;later<moments.length;later++){
    const left=moments[index],right=moments[later],films=new Set([...(left.films||[]).map(f=>f.film_key),left.film?.film_key,left.review?.film_key].filter(Boolean));
    const overlap=[...(right.films||[]).map(f=>f.film_key),right.film?.film_key,right.review?.film_key].filter(key=>films.has(key));
    if(overlap.length)callbacks.push({from:left.id,to:right.id,film_keys:overlap});
  }return callbacks.slice(0,12);
}
