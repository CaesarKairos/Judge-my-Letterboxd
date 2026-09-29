const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const intersection=(left,right)=>[...left].filter(key=>right.has(key));

export function buildRelationships(profile){
  const byFilm=new Map(profile.films.map(film=>[film.film_key,film]));
  const tagFilms=new Map();
  for(const session of profile.sessions||[])for(const tag of session.tags||[]){
    const group=tagFilms.get(tag)||new Set();group.add(session.film_key);tagFilms.set(tag,group);
  }
  const listFilms=new Map((profile.lists||[]).map(list=>[list.name,new Set((list.films||[]).map(film=>film.film_key))]));
  const relations=[];
  for(const [tag,tagSet] of tagFilms)for(const [name,listSet] of listFilms){
    const shared=intersection(tagSet,listSet),ratings=shared.map(key=>byFilm.get(key)?.rating).filter(Number.isFinite);
    if(shared.length)relations.push({type:'tag_list',tag,list:name,intersection:shared.length,list_count:listSet.size,tag_count:tagSet.size,coverage:listSet.size?shared.length/listSet.size:0,films:shared.slice(0,6),average_rating:mean(ratings)});
  }
  for(const [left,leftSet] of tagFilms)for(const [right,rightSet] of tagFilms)if(left<right){
    const shared=intersection(leftSet,rightSet);if(shared.length)relations.push({type:'tag_tag',left,right,intersection:shared.length,jaccard:shared.length/(leftSet.size+rightSet.size-shared.length),films:shared.slice(0,6)});
  }
  for(const [left,leftSet] of listFilms)for(const [right,rightSet] of listFilms)if(left<right){
    const shared=intersection(leftSet,rightSet);if(shared.length)relations.push({type:'list_list',left,right,intersection:shared.length,jaccard:shared.length/(leftSet.size+rightSet.size-shared.length),films:shared.slice(0,6)});
  }
  const globalRatings=profile.films.map(f=>f.rating).filter(Number.isFinite),globalMean=mean(globalRatings);
  for(const [tag,films] of tagFilms){
    const ratings=[...films].map(key=>byFilm.get(key)?.rating).filter(Number.isFinite),rewatched=[...films].filter(key=>(profile.sessions||[]).filter(s=>s.film_key===key).length>1);
    relations.push({type:'tag_rating',tag,count:films.size,average_rating:mean(ratings),global_average:globalMean,delta:mean(ratings)==null||globalMean==null?null:mean(ratings)-globalMean,distribution:Object.fromEntries(ratings.map(r=>[r,(ratings.filter(v=>v===r).length)])),exceptions:[...films].filter(key=>Number.isFinite(byFilm.get(key)?.rating)&&Math.abs(byFilm.get(key).rating-(mean(ratings)||0))>=1.5).slice(0,5)});
    if(rewatched.length)relations.push({type:'tag_rewatch',tag,rewatched_count:rewatched.length,tag_count:films.size,films:rewatched.slice(0,6)});
  }
  for(const [name,films] of listFilms){
    const ratings=[...films].map(key=>byFilm.get(key)?.rating).filter(Number.isFinite),rewatched=[...films].filter(key=>(profile.sessions||[]).filter(s=>s.film_key===key).length>1);
    relations.push({type:'list_rating',list:name,count:films.size,average_rating:mean(ratings),global_average:globalMean,lowest:[...films].map(key=>byFilm.get(key)).filter(f=>Number.isFinite(f?.rating)).sort((a,b)=>a.rating-b.rating).slice(0,3),highest:[...films].map(key=>byFilm.get(key)).filter(f=>Number.isFinite(f?.rating)).sort((a,b)=>b.rating-a.rating).slice(0,3)});
    if(rewatched.length)relations.push({type:'list_rewatch',list:name,rewatched_count:rewatched.length,list_count:films.size,films:rewatched.slice(0,6)});
  }
  const reviewLengths=(profile.reviews||[]).filter(r=>Number.isFinite(r.rating)).map(r=>({rating:r.rating,length:r.text.length,tags:r.tags||[],film_key:r.film_key}));
  if(reviewLengths.length)relations.push({type:'review_style_rating',by_rating:[...new Set(reviewLengths.map(r=>r.rating))].sort().map(rating=>({rating,average_length:mean(reviewLengths.filter(r=>r.rating===rating).map(r=>r.length)),count:reviewLengths.filter(r=>r.rating===rating).length}))});
  for(const [tag,films] of tagFilms){const rows=reviewLengths.filter(r=>films.has(r.film_key));if(rows.length)relations.push({type:'review_style_tag',tag,count:rows.length,average_length:mean(rows.map(r=>r.length))});}
  const favoriteKeys=new Set((profile.topFour||[]).map(f=>f.film_key));if(favoriteKeys.size)relations.push({type:'favorite_behavior',films:[...favoriteKeys].map(key=>{const film=byFilm.get(key);return {film_key:key,rating:film?.rating??null,sessions:(profile.sessions||[]).filter(s=>s.film_key===key).length,reviews:(profile.reviews||[]).filter(r=>r.film_key===key).length};})});
  relations.push({type:'watchlist_watched',watchlist_count:profile.watchlist||0,watched_count:profile.films.length});
  return {tag_count:tagFilms.size,list_count:listFilms.size,relations:relations.sort((a,b)=>(b.coverage||b.jaccard||0)-(a.coverage||a.jaccard||0)),tag_films:[...tagFilms].map(([tag,films])=>({tag,count:films.size,films:[...films]}))};
}
