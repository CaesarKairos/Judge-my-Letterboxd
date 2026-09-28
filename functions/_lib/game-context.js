const normalize=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export const TMDB_MIN_VOTE_COUNT=100;
const releaseYear=movie=>Number(String(movie?.release_date||'').slice(0,4))||null;
const pickMovie=(results,film)=>{
  const wanted=normalize(film.title),year=Number(film.year)||null;
  return (Array.isArray(results)?results:[]).filter(movie=>normalize(movie.title)===wanted||normalize(movie.original_title)===wanted)
    .sort((a,b)=>(year?Math.abs((releaseYear(a)||9999)-year)-Math.abs((releaseYear(b)||9999)-year):0)||(Number(b.vote_count)||0)-(Number(a.vote_count)||0))[0]||null;
};
async function tmdbMovie(film,env,locale){
  if(!env.TMDB_API_KEY)return null;
  try{
    const url=new URL('https://api.themoviedb.org/3/search/movie');
    url.search=new URLSearchParams({api_key:env.TMDB_API_KEY,query:film.title,include_adult:'false',...(film.year?{primary_release_year:String(film.year)}:{}),language:locale==='pt-BR'?'pt-BR':'en-US'}).toString();
    const response=await fetch(url,{signal:AbortSignal.timeout(5000)});
    if(!response.ok)return null;
    const movie=pickMovie((await response.json()).results,film);
    if(!movie||Number(movie.vote_count||0)<TMDB_MIN_VOTE_COUNT)return null;
    return {source:'TMDb',source_label:locale==='pt-BR'?'média do público no TMDb':'TMDb audience average',tmdb_id:movie.id,overview:String(movie.overview||'').slice(0,900),vote_average:Number(movie.vote_average)||null,vote_count:Number(movie.vote_count)||0,release_date:movie.release_date||''};
  }catch{return null;}
}
export async function enrichSelectedInteractions(games,profile,env,locale){
  const byKey=new Map(profile.films.map(f=>[f.film_key,f])),out=[];
  for(const game of games||[]){
    if(game.type!=='defend_your_take'){out.push(game);continue;}
    const film=byKey.get(game.film_keys?.[0]);if(!film)continue;
    const tmdb=await tmdbMovie(film,env,locale);if(!tmdb)continue;
    const review=(profile.reviews||[]).find(row=>row.review_id===game.review_id)||null;
    out.push({...game,tmdb,review:review?{review_id:review.review_id,film_key:review.film_key,title:review.title,year:review.year,rating:review.rating,text:review.text.slice(0,800)}:null});
  }
  return out;
}
