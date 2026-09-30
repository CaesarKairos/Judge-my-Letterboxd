export const TMDB_MIN_VOTE_COUNT=100;
const cache=new Map();
const normalized=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

async function json(url,env){
  const key=url.toString(),hit=cache.get(key);if(hit&&hit.expires>Date.now())return hit.value;
  const response=await fetch(url,{signal:AbortSignal.timeout(7000)});if(!response.ok)throw new Error(`tmdb_${response.status}`);
  const value=await response.json();cache.set(key,{value,expires:Date.now()+6*60*60*1000});return value;
}

export async function tmdbFilmContext(film,env,locale='pt-BR'){
  if(!env.TMDB_API_KEY)return null;
  const search=new URL('https://api.themoviedb.org/3/search/movie');search.search=new URLSearchParams({api_key:env.TMDB_API_KEY,query:film.title||'',include_adult:'false',language:locale,...(film.year?{primary_release_year:String(film.year)}:{})});
  try{
    const found=await json(search,env),wanted=normalized(film.title),movie=(found.results||[]).filter(row=>normalized(row.title)===wanted||normalized(row.original_title)===wanted).sort((a,b)=>(b.vote_count||0)-(a.vote_count||0))[0];if(!movie)return null;
    const details=new URL(`https://api.themoviedb.org/3/movie/${movie.id}`);details.search=new URLSearchParams({api_key:env.TMDB_API_KEY,language:locale,append_to_response:'credits'});const row=await json(details,env),director=row.credits?.crew?.find(person=>person.job==='Director')?.name||'';
    return {source:'TMDb',tmdb_id:row.id,overview:row.overview||'',genres:(row.genres||[]).map(item=>item.name).slice(0,5),vote_average:Number(row.vote_average)||null,vote_count:Number(row.vote_count)||0,director,runtime:Number(row.runtime)||null,sample_sufficient:(Number(row.vote_count)||0)>=TMDB_MIN_VOTE_COUNT};
  }catch(error){console.error('TMDb game enrichment failed',error.message);return null;}
}

export async function enrichGameInteractions(interactions,env,locale){
  const output=[];for(const game of interactions||[]){
    if(game.type!=='defend_your_take'){output.push(game);continue;}
    const contexts=(await Promise.all((game.films||[]).map(film=>tmdbFilmContext(film,env,locale)))).filter(Boolean),usable=contexts.find(row=>row.sample_sufficient);
    if(usable)output.push({...game,tmdb:usable,external_source_label:'média do público no TMDb'});
  }return output;
}
