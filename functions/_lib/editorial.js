const TYPE_ORDER=['writing_pattern','semantic_contrast','rewatch_pattern','tag_list_relationship','list_meaning','tag_meaning','review_spotlight','logging_behavior','favorite_behavior','exception','temporal_pattern','relationship'];
const family=moment=>({phrase:'writing',review_quote:'review',film_pair:'rating',rewatch:'rewatch',tag:'tag',list:'list',tag_list_relationship:'relationship',tag_tag_relationship:'relationship',list_list_relationship:'relationship'}[moment.type]||moment.type);
const maximumFor=richness=>richness>=100?12:richness>=35?10:8;
const scoreOf=moment=>{
  const interesting=Number.isFinite(moment.interestingness)?moment.interestingness:.5;
  const confidence=Number.isFinite(moment.confidence)?moment.confidence:.7;
  const info=Number.isFinite(moment.quality?.information_value)?moment.quality.information_value:.65;
  return interesting*.55+confidence*.25+info*.2;
};
const rejectionReason=moment=>{
  const interesting=Number.isFinite(moment.interestingness)?moment.interestingness:.5;
  const confidence=Number.isFinite(moment.confidence)?moment.confidence:.7;
  const info=Number.isFinite(moment.quality?.information_value)?moment.quality.information_value:.65;
  if(moment.low_information||moment.quality?.ubiquity>=.9)return 'ubiquitous_low_information';
  if(moment.quality?.redundancy>=.85&&moment.quality?.surprise<.35)return 'redundant_relationship';
  if(confidence<.62)return 'low_confidence';
  if(interesting<.6)return 'low_interestingness';
  if(info<.32&&interesting<.78)return 'low_information';
  if(scoreOf(moment)<.61)return 'below_editorial_threshold';
  return '';
};

export function materializeCandidates(candidates,deterministic){
  const byId=new Map(deterministic.map(moment=>[moment.id,moment]));
  return candidates.map(candidate=>{
    const base=byId.get(candidate.id);if(!base)return null;
    return {...base,editorial_type:candidate.editorial_type||candidate.type||base.type,observation:candidate.observation||'',why_interesting:candidate.why_interesting||'',cultural_angle:candidate.cultural_angle||'',interestingness:Number.isFinite(candidate.interestingness)?candidate.interestingness:.5,confidence:Number.isFinite(candidate.confidence)?candidate.confidence:.7};
  }).filter(Boolean);
}

export function buildEditorialSelection(moments,richness=0){
  const maximum=maximumFor(richness),rejected=[];
  const eligible=[];
  for(const moment of moments){
    const reason=rejectionReason(moment);
    if(reason)rejected.push({id:moment.id,type:moment.type,reason,score:scoreOf(moment)});
    else eligible.push(moment);
  }
  const ranked=eligible.sort((a,b)=>scoreOf(b)-scoreOf(a)),selected=[],used=new Set();
  // Quality determines membership. Diversity only breaks near-ties and avoids monotonous runs.
  while(selected.length<maximum){
    const pool=ranked.filter(moment=>!used.has(moment.id));if(!pool.length)break;
    const previous=selected.at(-1),best=pool[0],alternative=pool.find(moment=>family(moment)!==family(previous||{}));
    const chosen=previous&&alternative&&scoreOf(best)-scoreOf(alternative)<=.08?alternative:best;
    selected.push(chosen);used.add(chosen.id);
  }
  for(const moment of ranked)if(!used.has(moment.id))rejected.push({id:moment.id,type:moment.type,reason:'maximum_reached',score:scoreOf(moment)});
  return {selected,rejected,maximum};
}
export function buildScriptEngine(moments,richness=0){return buildEditorialSelection(moments,richness).selected;}

export function selectInteractions(candidates,max=2){
  const threshold=.66,ranked=(candidates||[]).map(row=>({...row,difficulty_score:Number(row.difficulty_score??row.difficulty)||0}))
    .sort((a,b)=>b.difficulty_score-a.difficulty_score);
  const rejected=[],eligible=[];
  for(const row of ranked){
    if(row.difficulty_score<threshold)rejected.push({id:row.id,type:row.type,reason:'low_difficulty',difficulty:row.difficulty_score});
    else eligible.push(row);
  }
  const selected=[];
  if(eligible.length)selected.push(eligible.shift());
  while(selected.length<max&&eligible.length){
    const different=eligible.find(row=>!selected.some(item=>item.type===row.type));
    const chosen=different||eligible[0];selected.push(chosen);eligible.splice(eligible.indexOf(chosen),1);
  }
  for(const row of eligible)rejected.push({id:row.id,type:row.type,reason:selected.length>=max?'maximum_games_reached':'game_variety',difficulty:row.difficulty_score});
  return {selected,rejected,maximum:max};
}

export function callbackCandidates(moments){
  const callbacks=[];for(let index=0;index<moments.length;index++)for(let later=index+1;later<moments.length;later++){
    const left=moments[index],right=moments[later],films=new Set([...(left.films||left.shared_films||[]).map(f=>f.film_key),left.film?.film_key,left.review?.film_key].filter(Boolean));
    const overlap=[...(right.films||right.shared_films||[]).map(f=>f.film_key),right.film?.film_key,right.review?.film_key].filter(key=>films.has(key));
    if(overlap.length)callbacks.push({from:left.id,to:right.id,film_keys:overlap});
  }return callbacks.slice(0,12);
}

export function editorialQualityReport({analysis,selection,games,writing}){
  const relationships=analysis.relationships?.relations||[],lines=(writing?.reactions||[]).flatMap(row=>row.lines||[]);
  const generic=/^(isso (diz|mostra)|é interessante|interessante|há variações|tudo se conecta|você reassiste|uma seleção pessoal)/i;
  const possible_expository_lines=lines.filter(line=>generic.test(String(line).trim()));
  return {
    selected_candidates:(selection?.selected||[]).map(row=>({id:row.id,type:row.type,score:scoreOf(row)})),
    rejected_candidates:selection?.rejected||[],
    rejection_reasons:[...new Set((selection?.rejected||[]).map(row=>row.reason))],
    ubiquitous_relationships:relationships.filter(row=>row.ubiquity>=.8).map(row=>({type:row.type,tag:row.tag,left:row.left,right:row.right,ubiquity:row.ubiquity})),
    redundant_relationships:relationships.filter(row=>row.redundancy>=.8).map(row=>({type:row.type,tag:row.tag,list:row.list,left:row.left,right:row.right,redundancy:row.redundancy})),
    low_information_candidates:(selection?.rejected||[]).filter(row=>['low_information','ubiquitous_low_information','redundant_relationship'].includes(row.reason)),
    selected_games:(games?.selected||[]).map(row=>({id:row.id,type:row.type,difficulty:row.difficulty_score??row.difficulty,difficulty_reason:row.difficulty_reason||row.why_difficult})),
    rejected_games:games?.rejected||[],
    possible_expository_lines,
    possible_restatements:[]
  };
}
