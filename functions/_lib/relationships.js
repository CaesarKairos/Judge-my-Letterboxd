const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const intersection=(left,right)=>[...left].filter(key=>right.has(key));
const difference=(left,right)=>[...left].filter(key=>!right.has(key));
const clamp=value=>Math.max(0,Math.min(1,Number(value)||0));
export const normalizeRelationshipName=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
const redundancyScore=(left,right)=>{
  const a=normalizeRelationshipName(left),b=normalizeRelationshipName(right);if(!a||!b)return 0;if(a===b)return 1;
  const A=new Set(a.split(' ')),B=new Set(b.split(' ')),shared=[...A].filter(token=>B.has(token)).length,union=new Set([...A,...B]).size;
  const j=union?shared/union:0;return j>=.8?.9:j>=.6?.65:0;
};
const surpriseFromLift=lift=>!Number.isFinite(lift)?0:clamp((lift-1)/2);
const quality=(sample,ubiquity,surprise,redundancy,lift)=>({
  sample_size:sample,ubiquity:clamp(ubiquity),surprise:clamp(surprise),redundancy:clamp(redundancy),lift:Number.isFinite(lift)?lift:null,
  information_value:clamp(Math.min(1,sample/6)*.28+(1-clamp(ubiquity))*.34+clamp(surprise)*.38-clamp(redundancy)*.5)
});

export function buildRelationships(profile){
  const byFilm=new Map(profile.films.map(film=>[film.film_key,film])),watched=Math.max(1,profile.films.length);
  const tagFilms=new Map();
  for(const session of profile.sessions||[])for(const tag of session.tags||[]){
    const group=tagFilms.get(tag)||new Set();group.add(session.film_key);tagFilms.set(tag,group);
  }
  const listFilms=new Map((profile.lists||[]).map(list=>[list.name,new Set((list.films||[]).map(film=>film.film_key))]));
  const relations=[];
  for(const [tag,tagSet] of tagFilms)for(const [name,listSet] of listFilms){
    const shared=intersection(tagSet,listSet);if(!shared.length)continue;
    const ratings=shared.map(key=>byFilm.get(key)?.rating).filter(Number.isFinite),expected=(tagSet.size*listSet.size)/watched,lift=expected?shared.length/expected:null;
    const listWithout=difference(listSet,tagSet),tagWithout=difference(tagSet,listSet),redundancy=redundancyScore(tag,name),ubiquity=tagSet.size/watched,surprise=surpriseFromLift(lift);
    relations.push({type:'tag_list',tag,list:name,observed_overlap:shared.length,intersection:shared.length,list_count:listSet.size,tag_count:tagSet.size,
      coverage:shared.length/listSet.size,coverage_list:shared.length/listSet.size,coverage_tag:shared.length/tagSet.size,expected_overlap:expected,lift,
      films:shared.slice(0,8),shared_films:shared.slice(0,8),average_rating:mean(ratings),list_without_tag:listWithout.slice(0,12),tag_without_list:tagWithout.slice(0,12),
      symmetric_difference:[...listWithout,...tagWithout].slice(0,20),redundancy,...quality(shared.length,ubiquity,surprise,redundancy,lift)});
  }
  for(const [left,leftSet] of tagFilms)for(const [right,rightSet] of tagFilms)if(left<right){
    const shared=intersection(leftSet,rightSet);if(!shared.length)continue;
    const expected=(leftSet.size*rightSet.size)/watched,lift=expected?shared.length/expected:null,ubiquity=Math.max(leftSet.size,rightSet.size)/watched,redundancy=redundancyScore(left,right);
    relations.push({type:'tag_tag',left,right,intersection:shared.length,observed_overlap:shared.length,expected_overlap:expected,lift,jaccard:shared.length/(leftSet.size+rightSet.size-shared.length),
      films:shared.slice(0,8),left_without_right:difference(leftSet,rightSet).slice(0,12),right_without_left:difference(rightSet,leftSet).slice(0,12),redundancy,
      ...quality(shared.length,ubiquity,surpriseFromLift(lift),redundancy,lift)});
  }
  for(const [left,leftSet] of listFilms)for(const [right,rightSet] of listFilms)if(left<right){
    const shared=intersection(leftSet,rightSet);if(!shared.length)continue;
    const expected=(leftSet.size*rightSet.size)/watched,lift=expected?shared.length/expected:null,redundancy=redundancyScore(left,right);
    relations.push({type:'list_list',left,right,intersection:shared.length,observed_overlap:shared.length,expected_overlap:expected,lift,jaccard:shared.length/(leftSet.size+rightSet.size-shared.length),
      films:shared.slice(0,8),left_without_right:difference(leftSet,rightSet).slice(0,12),right_without_left:difference(rightSet,leftSet).slice(0,12),redundancy,
      ...quality(shared.length,0,surpriseFromLift(lift),redundancy,lift)});
  }
  const globalRatings=profile.films.map(f=>f.rating).filter(Number.isFinite),globalMean=mean(globalRatings);
  for(const [tag,films] of tagFilms){
    const ratings=[...films].map(key=>byFilm.get(key)?.rating).filter(Number.isFinite),rewatched=[...films].filter(key=>(profile.sessions||[]).filter(s=>s.film_key===key).length>1),prevalence=films.size/watched;
    const avg=mean(ratings),delta=avg==null||globalMean==null?null:avg-globalMean,surprise=delta==null?0:clamp(Math.abs(delta)/2);
    relations.push({type:'tag_rating',tag,count:films.size,tag_prevalence:prevalence,prevalence,average_rating:avg,global_average:globalMean,delta,
      distribution:Object.fromEntries(ratings.map(r=>[r,(ratings.filter(v=>v===r).length)])),exceptions:[...films].filter(key=>Number.isFinite(byFilm.get(key)?.rating)&&Math.abs(byFilm.get(key).rating-(avg||0))>=1.5).slice(0,5),
      ...quality(films.size,prevalence,surprise,0,null)});
    if(rewatched.length)relations.push({type:'tag_rewatch',tag,rewatched_count:rewatched.length,tag_count:films.size,tag_prevalence:prevalence,films:rewatched.slice(0,6),...quality(rewatched.length,prevalence,rewatched.length/Math.max(1,films.size),0,null)});
  }
  for(const [name,films] of listFilms){
    const ratings=[...films].map(key=>byFilm.get(key)?.rating).filter(Number.isFinite),rewatched=[...films].filter(key=>(profile.sessions||[]).filter(s=>s.film_key===key).length>1);
    relations.push({type:'list_rating',list:name,count:films.size,average_rating:mean(ratings),global_average:globalMean,lowest:[...films].map(key=>byFilm.get(key)).filter(f=>Number.isFinite(f?.rating)).sort((a,b)=>a.rating-b.rating).slice(0,3),highest:[...films].map(key=>byFilm.get(key)).filter(f=>Number.isFinite(f?.rating)).sort((a,b)=>b.rating-a.rating).slice(0,3),...quality(films.size,0,.35,0,null)});
    if(rewatched.length)relations.push({type:'list_rewatch',list:name,rewatched_count:rewatched.length,list_count:films.size,films:rewatched.slice(0,6),...quality(rewatched.length,0,rewatched.length/Math.max(1,films.size),0,null)});
  }
  const reviewLengths=(profile.reviews||[]).filter(r=>Number.isFinite(r.rating)).map(r=>({rating:r.rating,length:r.text.length,tags:r.tags||[],film_key:r.film_key}));
  if(reviewLengths.length)relations.push({type:'review_style_rating',by_rating:[...new Set(reviewLengths.map(r=>r.rating))].sort().map(rating=>({rating,average_length:mean(reviewLengths.filter(r=>r.rating===rating).map(r=>r.length)),count:reviewLengths.filter(r=>r.rating===rating).length}))});
  for(const [tag,films] of tagFilms){const rows=reviewLengths.filter(r=>films.has(r.film_key));if(rows.length)relations.push({type:'review_style_tag',tag,count:rows.length,average_length:mean(rows.map(r=>r.length)),tag_prevalence:films.size/watched});}
  const favoriteKeys=new Set((profile.topFour||[]).map(f=>f.film_key));if(favoriteKeys.size)relations.push({type:'favorite_behavior',films:[...favoriteKeys].map(key=>{const film=byFilm.get(key);return {film_key:key,rating:film?.rating??null,sessions:(profile.sessions||[]).filter(s=>s.film_key===key).length,reviews:(profile.reviews||[]).filter(r=>r.film_key===key).length};})});
  relations.push({type:'watchlist_watched',watchlist_count:profile.watchlist||0,watched_count:profile.films.length});
  return {tag_count:tagFilms.size,list_count:listFilms.size,relations:relations.sort((a,b)=>(b.information_value||0)-(a.information_value||0)||(b.coverage||b.jaccard||0)-(a.coverage||a.jaccard||0)),
    tag_films:[...tagFilms].map(([tag,films])=>({tag,count:films.size,prevalence:films.size/watched,ubiquity:films.size/watched,films:[...films]}))};
}
