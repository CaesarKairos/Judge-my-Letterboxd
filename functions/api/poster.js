const normalize = value => String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export function matchMovie(results,title,year) {
  const matches=results.filter(movie=>[movie.title,movie.original_title].some(t=>normalize(t)===normalize(title))&&(!year||movie.release_date?.slice(0,4)===year));
  return matches.length===1 ? matches[0] : null;
}
export async function onRequestGet({request,env}) {
  const query=new URL(request.url).searchParams,title=(query.get('title')||'').trim(),year=query.get('year')||'';
  const reply=(data,status=200,ttl=3600)=>Response.json(data,{status,headers:{'Cache-Control':`public, max-age=${ttl}, s-maxage=${ttl}`,'X-Content-Type-Options':'nosniff'}});
  const missing={poster_url:null,tmdb_id:null,resolved:false};
  if(!title||title.length>200||(year&&!/^\d{4}$/.test(year)))return reply(missing,400,60);
  if(!env.TMDB_API_KEY)return reply(missing,200,300);
  const url=new URL('https://api.themoviedb.org/3/search/movie');
  url.search=new URLSearchParams({api_key:env.TMDB_API_KEY,query:title,...(year?{primary_release_year:year}:{}),include_adult:'false'}).toString();
  try {
    const response=await fetch(url,{signal:AbortSignal.timeout(5000)});
    if(!response.ok)return reply(missing,200,300);
    const data=await response.json();const movie=matchMovie(Array.isArray(data.results)?data.results:[],title,year);
    if(!movie?.poster_path||!/^\/[\w.-]+$/.test(movie.poster_path))return reply(missing);
    return reply({poster_url:`https://image.tmdb.org/t/p/w342${movie.poster_path}`,tmdb_id:movie.id,resolved:true},200,604800);
  }catch{return reply(missing,200,300);}
}
