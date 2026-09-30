import {GAME_TYPES,GAME_MIN_DIFFICULTY,GAME_MAX_SELECTED,poolGames} from './interaction-pool.js';
import {buildEvidenceRegistry} from './evidence-registry.js';
import {normalizeSemanticFindings} from './semantic-findings.js';

const TYPE_ORDER=['writing_pattern','semantic_contrast','semantic_pattern','semantic_exception','semantic_habit','semantic_asymmetry','semantic_callback','rewatch_pattern','tag_list_relationship','tag_tag_relationship','list_list_relationship','list_meaning','tag_meaning','review_spotlight','logging_behavior','favorite_behavior','exception','temporal_pattern','relationship'];
const family=moment=>({phrase:'writing',review_quote:'review',film_pair:'rating',rewatch:'rewatch',tag:moment.relationship?'relationship':'tag',list:'list'}[moment.type]||moment.type);

export function materializeCandidates(candidates,deterministic){
  const byId=new Map(deterministic.map(moment=>[moment.id,moment]));
  return candidates.map(candidate=>{
    const base=byId.get(candidate.id);if(!base)return null;
    return {...base,editorial_type:candidate.editorial_type||base.type,observation:candidate.observation||'',why_interesting:candidate.why_interesting||'',cultural_angle:candidate.cultural_angle||'',interestingness:Number.isFinite(candidate.interestingness)?candidate.interestingness:.5,confidence:Number.isFinite(candidate.confidence)?candidate.confidence:.7};
  }).filter(Boolean);
}

export function buildScriptEngine(moments,richness=0){
  const maximum=richness>=100?12:richness>=35?10:8,hasEditorialScores=moments.some(row=>(row.interestingness||0)!==.5),eligible=hasEditorialScores?moments.filter(row=>(row.interestingness||0)>=.62&&(row.confidence||0)>=.6):moments,ranked=[...eligible].sort((a,b)=>(b.interestingness||0)-(a.interestingness||0));
  const selected=[],used=new Set(),usage=new Map();
  const take=moment=>{selected.push(moment);used.add(moment.id);usage.set(family(moment),(usage.get(family(moment))||0)+1);};
  // First pass creates variety: one moment per wanted family before any family repeats.
  for(const wanted of TYPE_ORDER)for(const moment of ranked)if(!used.has(moment.id)&&(moment.editorial_type===wanted||family(moment)===wanted)){take(moment);break;}
  // The cap is a maximum, never a quota. Only candidates that cleared the editorial gate enter.
  let guard=ranked.length;
  while(selected.length<maximum&&guard-->0){
    const previousFamily=selected.length?family(selected.at(-1)):null;
    const pool=ranked.filter(moment=>!used.has(moment.id));
    if(!pool.length)break;
    const fresh=pool.filter(moment=>family(moment)!==previousFamily);
    const candidates=(fresh.length?fresh:pool).sort((a,b)=>(usage.get(family(a))||0)-(usage.get(family(b))||0));
    take(candidates[0]);
  }
  return selected.slice(0,maximum);
}

// A playable challenge needs a real difficulty, films that exist and the right number of films for
// its type: three for a choice between equals, one to three for a defense of one score.
export function isPlayableGame(game,byKey){
  if(!game||!GAME_TYPES.includes(game.type)||!(Number(game.difficulty)>=GAME_MIN_DIFFICULTY))return false;
  const keys=(Array.isArray(game.film_keys)?game.film_keys:[]).filter(key=>typeof key==='string'&&key);
  if(!keys.length||!keys.every(key=>byKey.has(key)))return false;
  return game.type==='defend_your_take'?keys.length<=3:keys.length===3;
}

// The Analyst picks; the pool guarantees. Two challenges of different types are the default, and a
// deterministic pool entry is only used when the Analyst did not offer enough playable options —
// the interpretation and the punchline still belong to the Writer, so this is not a fallback
// judgment, it is a fallback opportunity.
export function selectInteractions(candidates=[],profile,{pool=[],minimum=GAME_MAX_SELECTED}={}){
  const byKey=new Map((profile?.films||[]).map(film=>[film.film_key,film]));
  const fromAnalyst=(candidates||[]).filter(game=>isPlayableGame(game,byKey)).sort((a,b)=>b.difficulty-a.difficulty);
  const fromPool=poolGames(pool).filter(game=>isPlayableGame(game,byKey));
  const target=Math.min(GAME_MAX_SELECTED,Math.max(0,Number(minimum)||0)),selected=[],types=new Set(),ids=new Set();
  const take=game=>{
    if(ids.has(game.id))return false;
    ids.add(game.id);types.add(game.type);
    selected.push({...game,source:GAME_TYPES.includes(game.type)?(game.origin==='pool'?'pool':'analyst'):'analyst',films:game.film_keys.map(key=>byKey.get(key))});
    return true;
  };
  // Variety first: the two final challenges should not be the same exercise twice.
  for(const game of [...fromAnalyst,...fromPool]){if(selected.length>=target)break;if(types.has(game.type))continue;take(game);}
  for(const game of [...fromAnalyst,...fromPool]){if(selected.length>=target)break;take(game);}
  return selected;
}

// One entry point for the whole editorial stage, so the API function, the offline pipeline and the
// tests can never assemble the material differently: measurements the Analyst selected, semantic
// findings it discovered, the Script Engine and the two challenges.
export function buildEditorialSelection({profile,analysis,analyst={},pool=[],richness=0}){
  const measurements=materializeCandidates(analyst.selected||[],analysis.moments||[]);
  const semantic=(analyst.semantic_moments?.length?{accepted:analyst.semantic_moments,rejected:analyst.rejected_semantic_findings||[],limit:null}
    :normalizeSemanticFindings(analyst.semantic_findings||[],buildEvidenceRegistry({profile,analysis}),{existingIds:new Set((analysis.moments||[]).map(moment=>moment.id))}));
  const moments=buildScriptEngine([...measurements,...semantic.accepted],richness);
  const interactions=selectInteractions(analyst.interaction_candidates||[],profile,{pool});
  return {measurements,semantic,moments,interactions,pool};
}

export function callbackCandidates(moments){
  const callbacks=[];for(let index=0;index<moments.length;index++)for(let later=index+1;later<moments.length;later++){
    const left=moments[index],right=moments[later],films=new Set([...(left.films||[]).map(f=>f.film_key),left.film?.film_key,left.review?.film_key].filter(Boolean));
    const overlap=[...(right.films||[]).map(f=>f.film_key),right.film?.film_key,right.review?.film_key].filter(key=>films.has(key));
    if(overlap.length)callbacks.push({from:left.id,to:right.id,film_keys:overlap});
  }return callbacks.slice(0,12);
}
