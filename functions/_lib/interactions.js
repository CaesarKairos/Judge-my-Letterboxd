const clamp=value=>Math.max(0,Math.min(1,Number(value)||0));
const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;
const combinations=items=>{const out=[];for(let a=0;a<items.length;a++)for(let b=a+1;b<items.length;b++)for(let c=b+1;c<items.length;c++)out.push([items[a],items[b],items[c]]);return out;};

export function affinityProfile(profile){
  const rated=profile.films.filter(f=>Number.isFinite(f.rating)).sort((a,b)=>a.rating-b.rating);
  const percentile=new Map(rated.map((film,index)=>[film.film_key,rated.length<=1?1:index/(rated.length-1)]));
  const favorites=new Set((profile.topFour||[]).map(f=>f.film_key));
  const reviewsByFilm=new Map();
  for(const review of profile.reviews||[]){const rows=reviewsByFilm.get(review.film_key)||[];rows.push(review);reviewsByFilm.set(review.film_key,rows);}
  const sessionsByFilm=new Map();
  for(const session of profile.sessions||[]){const rows=sessionsByFilm.get(session.film_key)||[];rows.push(session);sessionsByFilm.set(session.film_key,rows);}
  const listsByFilm=new Map();
  for(const list of profile.lists||[])for(const film of list.films||[]){const rows=listsByFilm.get(film.film_key)||[];rows.push(list.name);listsByFilm.set(film.film_key,rows);}
  return new Map(profile.films.map(film=>{
    const reviews=reviewsByFilm.get(film.film_key)||[],sessions=sessionsByFilm.get(film.film_key)||[],lists=listsByFilm.get(film.film_key)||[];
    const rating=Number.isFinite(film.rating)?film.rating/5:0;
    const ratingPercentile=percentile.get(film.film_key)??0;
    const reviewIntensity=reviews.length?Math.min(1,Math.max(...reviews.map(review=>String(review.text||'').length))/500):0;
    const rewatch=Math.min(1,Math.max(0,sessions.length-1)/2);
    const score=clamp(rating*.28+ratingPercentile*.14+(favorites.has(film.film_key)?.2:0)+rewatch*.14+(reviews.length?.08:0)+reviewIntensity*.06+(lists.length?.1:0));
    return [film.film_key,{score,rating_percentile:ratingPercentile,favorite:favorites.has(film.film_key),rewatches:Math.max(0,sessions.length-1),review_count:reviews.length,review_intensity:reviewIntensity,list_count:lists.length}];
  }));
}

const trioDifficulty=(films,affinity,semanticBonus=.1)=>{
  const ratings=films.map(f=>f.rating).filter(Number.isFinite);
  if(ratings.length<3)return {score:0,reason:'missing comparable ratings',range:null};
  const range=Math.max(...ratings)-Math.min(...ratings),closeness=clamp(1-range/2.5),high=clamp(mean(ratings)/5),attachment=mean(films.map(f=>affinity.get(f.film_key)?.score||0));
  const score=clamp(closeness*.42+high*.22+attachment*.31+semanticBonus*.05-(range>=2.5?.35:0));
  return {score,range,reason:`ratings within ${range.toFixed(1)} stars; affinity signals average ${attachment.toFixed(2)}`};
};

export function buildInteractionCandidates(profile,relationships){
  const byKey=new Map(profile.films.map(f=>[f.film_key,f])),affinity=affinityProfile(profile),groups=[];
  for(const list of profile.lists||[]){
    const films=(list.films||[]).map(f=>byKey.get(f.film_key)).filter(Boolean);
    if(films.length>=3)groups.push({kind:'list',name:list.name,films});
  }
  for(const tag of relationships?.tag_films||[]){
    const films=(tag.films||[]).map(key=>byKey.get(key)).filter(Boolean);
    if(films.length>=3&&Number(tag.prevalence??0)<.9)groups.push({kind:'tag',name:tag.tag,films});
  }
  const trioCandidates=[];
  for(const group of groups){
    const shortlist=[...group.films].sort((a,b)=>(affinity.get(b.film_key)?.score||0)-(affinity.get(a.film_key)?.score||0)).slice(0,6);
    for(const trio of combinations(shortlist)){
      const difficulty=trioDifficulty(trio,affinity,.8);
      trioCandidates.push({group,trio,difficulty});
    }
  }
  trioCandidates.sort((a,b)=>b.difficulty.score-a.difficulty.score);
  const interactions=[];let serial=1;
  for(const row of trioCandidates.slice(0,8)){
    const film_keys=row.trio.map(f=>f.film_key),affinity_signals=Object.fromEntries(film_keys.map(key=>[key,affinity.get(key)]));
    interactions.push({id:`game-triage-${serial++}`,type:'forced_triage',film_keys,difficulty:row.difficulty.score,difficulty_score:row.difficulty.score,difficulty_reason:row.difficulty.reason,why_difficult:row.difficulty.reason,why_interesting:`Three similarly valued films share ${row.group.kind} context "${row.group.name}".`,context:{type:row.group.kind,name:row.group.name},affinity_signals,evidence_refs:film_keys});
    interactions.push({id:`game-blind-${serial++}`,type:'blind_rank',film_keys,difficulty:clamp(row.difficulty.score*.97),difficulty_score:clamp(row.difficulty.score*.97),difficulty_reason:row.difficulty.reason,why_difficult:row.difficulty.reason,why_interesting:`Blind ranking removes hindsight among three closely matched films from "${row.group.name}".`,context:{type:row.group.kind,name:row.group.name},affinity_signals,evidence_refs:film_keys});
  }
  const strongReviews=(profile.reviews||[]).filter(review=>Number.isFinite(review.rating)&&String(review.text||'').trim().length>=45)
    .map(review=>({review,film:byKey.get(review.film_key),intensity:Math.min(1,String(review.text||'').length/450)}))
    .filter(row=>row.film)
    .sort((a,b)=>(b.intensity+(affinity.get(b.film.film_key)?.score||0))-(a.intensity+(affinity.get(a.film.film_key)?.score||0)));
  for(const [index,row] of strongReviews.slice(0,4).entries()){
    const score=clamp(.55+row.intensity*.2+(affinity.get(row.film.film_key)?.score||0)*.2);
    interactions.push({id:`game-defend-${index+1}`,type:'defend_your_take',film_keys:[row.film.film_key],review_id:row.review.review_id,difficulty:score,difficulty_score:score,difficulty_reason:'A strong written take gives the Judge something concrete to cross-examine.',why_difficult:'The user already committed to a specific written opinion.',why_interesting:'The review can be questioned against film context without treating public consensus as authority.',requires_tmdb:true,evidence_refs:[row.review.review_id,row.film.film_key]});
  }
  const dedup=new Map();
  for(const row of interactions){const signature=`${row.type}:${[...row.film_keys].sort().join('|')}`;if(!dedup.has(signature)||dedup.get(signature).difficulty<row.difficulty)dedup.set(signature,row);}
  return [...dedup.values()].sort((a,b)=>b.difficulty-a.difficulty).slice(0,16);
}

export function interactionDifficulty(candidate){
  return clamp(candidate?.difficulty_score??candidate?.difficulty??0);
}
