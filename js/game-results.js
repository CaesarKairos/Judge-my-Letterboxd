export function blindRankOutcome(ranks=[],films=[]){
  if(ranks.length!==3||films.length!==3)return 'chaotic_mismatch';
  const ratings=films.map(film=>Number(film.rating));if(ratings.some(value=>!Number.isFinite(value)))return 'unscored';if(new Set(ratings).size<ratings.length)return 'historically_tied';
  const history=[...films].map((film,index)=>({index,rating:Number(film.rating)})).sort((a,b)=>b.rating-a.rating||a.index-b.index).map((row,index)=>[row.index,index+1]);
  const expected=new Map(history),distance=ranks.reduce((sum,rank,index)=>sum+Math.abs(rank-(expected.get(index)||rank)),0);
  return distance===0?'match':distance<=2?'near_match':'chaotic_mismatch';
}
export function forcedTriageReaction(assignments=[],hints=[]){
  for(const assignment of [...assignments].sort((a,b)=>a.rank-b.rank)){const found=hints.find(hint=>hint.film_key===assignment.film_key&&hint.role_id===assignment.role_id);if(found?.text)return found.text;}return '';
}
