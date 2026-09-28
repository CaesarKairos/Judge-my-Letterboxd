import {el,icon,safeImage} from './utils.js';
import {locale,t} from './i18n.js';
const memory=new Map(), TTL=7*86400000;
export async function resolvePoster(film) {
  const supplied=safeImage(film.poster_url); if(supplied)return supplied;
  const key=`jml:poster:v1:${film.title}:${film.year||''}`;
  if(memory.has(key))return memory.get(key);
  const pending=(async()=>{
    try {const stored=JSON.parse(localStorage.getItem(key));if(stored?.expires>Date.now()&&safeImage(stored.url))return stored.url;}catch{}
    try {
      const response=await fetch(`/api/poster?${new URLSearchParams({title:film.title||'',year:film.year||'',locale})}`,{signal:AbortSignal.timeout(8000)});
      // A definitive "no" stays cached for the session; a transient failure does not, so a
      // later render (another card with the same film) can ask the endpoint again.
      if(!response.ok){if(response.status>=500||response.status===429)memory.delete(key);return null;}
      const data=await response.json(), url=data.resolved&&safeImage(data.poster_url);
      if(url)try{localStorage.setItem(key,JSON.stringify({url,expires:Date.now()+TTL}));}catch{}
      return url||null;
    }catch{memory.delete(key);return null;}
  })();
  memory.set(key,pending);return pending;
}
const observer = new IntersectionObserver(entries=>entries.forEach(entry=>{
  if(entry.isIntersecting){observer.unobserve(entry.target);entry.target.dispatchEvent(new Event('resolveposter'));}
}),{rootMargin:'240px'});
export function poster(film,{eager=false}={}) {
  const box=el('div','poster');
  const fallback=el('div','poster-fallback');fallback.append(icon('film-symbol',26),el('strong','',film.title),el('span','poster-year',film.year));box.append(fallback);
  const load=async()=>{
    const url=await resolvePoster(film);if(!url)return;
    const img=el('img','poster-image');img.alt=`${film.title}${film.year?` (${film.year})`:''}`;img.loading=eager?'eager':'lazy';img.decoding='async';
    img.addEventListener('load',()=>fallback.hidden=true);img.addEventListener('error',()=>{img.remove();fallback.hidden=false;});img.src=url;box.append(img);
  };
  if(eager)load();else{box.addEventListener('resolveposter',load,{once:true});observer.observe(box);}
  return box;
}
export function rating(value){return el('span','rating',value==null?t('noRating'):`★ ${value} / 5`);}
export function filmCard(film,options={}) {
  const card=el('figure','film-card');card.append(poster(film,options));
  const caption=el('figcaption');caption.append(el('strong','film-title',film.title),el('span','film-year',film.year));
  if(options.showRating!==false)caption.append(rating(film.rating));
  card.append(caption);return card;
}
export function disconnectPosters(){observer.disconnect();}
