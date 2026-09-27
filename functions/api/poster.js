const normalize = value => String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const popularity = movie => Number(movie?.popularity||movie?.vote_count||0)||0;
const releaseYear = movie => {const year=Number(String(movie?.release_date||'').slice(0,4));return Number.isFinite(year)&&year>1800?year:null;};
// Matching rules: same normalized title (or original title) and artwork, closest release
// year (exact first, one year of tolerance for festival versus release dates) and, when
// entries still tie, the most popular one. Anything looser keeps the abstract fallback.
export function matchMovie(results, title, year) {
  const wanted=normalize(title),target=/^\d{4}$/.test(String(year||''))?Number(year):null;
  const candidates=(Array.isArray(results)?results:[]).filter(movie=>movie&&movie.poster_path&&(normalize(movie.title)===wanted||normalize(movie.original_title)===wanted));
  if(!candidates.length)return null;
  const rank=movie=>target?(releaseYear(movie)!=null?Math.abs(releaseYear(movie)-target):99):0;
  const best=candidates.slice().sort((a,b)=>rank(a)-rank(b)||popularity(b)-popularity(a))[0];
  return target&&rank(best)>1?null:best;
}

export async function onRequestGet({request,env}) {
  const params=new URL(request.url).searchParams;
  const title=(params.get('title')||'').trim(),year=(params.get('year')||'').trim(),locale=(params.get('locale')||'').trim().slice(0,12);
  const reply=(data,status=200,ttl=3600)=>Response.json(data,{status,headers:{'Cache-Control':`public, max-age=${ttl}, s-maxage=${ttl}`,'X-Content-Type-Options':'nosniff'}});
  // Every refused lookup says why, so the endpoint itself can be inspected when a poster
  // falls back to the abstract card: /api/poster?title=Young%20Hearts&year=2024
  const missing=reason=>({poster_url:null,tmdb_id:null,resolved:false,reason});
  if(!title||title.length>200||(year&&!/^\d{4}$/.test(year)))return reply(missing('invalid_query'),400,60);
  if(!env.TMDB_API_KEY)return reply(missing('missing_tmdb_key'),200,300);
  const languages=[locale].filter(value=>value&&value.toLowerCase()!=='en-us');
  const passes=[];
  if(year)for(const language of [undefined,...languages])passes.push({language,useYear:true});
  // The year filter hides films whose TMDB release year differs by one, so it is dropped
  // before giving up; each pass is also tried in the viewer language for translated titles.
  for(const language of [undefined,...languages])passes.push({language,useYear:false});
  try {
    for(const pass of passes) {
      const url=new URL('https://api.themoviedb.org/3/search/movie');
      url.search=new URLSearchParams({api_key:env.TMDB_API_KEY,query:title,include_adult:'false',...(pass.useYear&&year?{primary_release_year:year}:{}),...(pass.language?{language:pass.language}:{})}).toString();
      const response=await fetch(url,{signal:AbortSignal.timeout(5000)});
      if(!response.ok){console.error('TMDB poster search failed',response.status);return reply(missing('tmdb_error'),200,300);}
      const data=await response.json(),movie=matchMovie(Array.isArray(data.results)?data.results:[],title,year);
      if(movie&&/^\/[\w.-]+$/.test(movie.poster_path))return reply({poster_url:`https://image.tmdb.org/t/p/w342${movie.poster_path}`,tmdb_id:movie.id,resolved:true},200,604800);
    }
  } catch(error) {console.error('TMDB poster lookup failed',error.name||error.message);return reply(missing('tmdb_unreachable'),200,300);}
  return reply(missing('no_match'),200,300);
}
