import {filmCard} from './poster-service.js';
import {filmsFromExport} from './export-preview.js';
export {filmsFromExport} from './export-preview.js';
export function startLoadingPreview(file,host){
  let stopped=false,timer=null,index=0,cycle=[],track;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches,count=matchMedia('(max-width: 520px)').matches?3:6;
  host.replaceChildren();host.dataset.loading='true';
  const reshuffle=films=>{cycle=[...films];for(let i=cycle.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[cycle[i],cycle[j]]=[cycle[j],cycle[i]];}index=0;};
  const next=films=>{if(index>=cycle.length)reshuffle(films);return cycle[index++];};
  const card=film=>{const node=filmCard(film,{showRating:false,eager:false});node.dataset.film=`${film.title}|${film.year||''}`;node.querySelectorAll('img').forEach(img=>img.draggable=false);return node;};
  filmsFromExport(file).then(films=>{if(stopped||!films.length)return;cycle=films;track=document.createElement('div');track.className='loading-film-track';for(let i=0;i<count+2;i++)track.append(card(next(films)));host.append(track);
    const advance=()=>{if(stopped)return;if(reduced){track.firstElementChild?.remove();track.append(card(next(films)));timer=setTimeout(advance,3200);return;}track.classList.add('advancing');timer=setTimeout(()=>{if(stopped)return;track.firstElementChild?.remove();track.classList.remove('advancing');track.append(card(next(films)));timer=setTimeout(advance,1450);},650);};
    timer=setTimeout(advance,reduced?3200:1200);
  }).catch(()=>{});
  const stop=()=>{stopped=true;clearTimeout(timer);host.replaceChildren();delete host.dataset.loading;};stop.finish=()=>{host.dataset.loading='ready';track?.classList.add('settling');clearTimeout(timer);};return stop;
}
