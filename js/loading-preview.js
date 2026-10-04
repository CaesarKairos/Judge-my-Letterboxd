import {filmCard} from './poster-service.js';
import {filmsFromExport} from './export-preview.js';
export {filmsFromExport} from './export-preview.js';
export function startLoadingPreview(file,host){
  let stopped=false,timer=null,index=0;host.replaceChildren();host.dataset.loading='true';
  filmsFromExport(file).then(films=>{if(stopped||!films.length)return;const count=matchMedia('(max-width: 520px)').matches?3:4,render=()=>{if(stopped)return;const track=document.createElement('div');track.className='loading-film-track';for(let offset=0;offset<count;offset++){const card=filmCard(films[(index+offset)%films.length],{showRating:false,eager:offset<3});card.querySelectorAll('img').forEach(img=>img.draggable=false);track.append(card);}host.replaceChildren(track);index=(index+count)%films.length;if(!matchMedia('(prefers-reduced-motion: reduce)').matches)timer=setTimeout(render,3200);};render();}).catch(()=>{});
  return ()=>{stopped=true;clearTimeout(timer);host.replaceChildren();delete host.dataset.loading;};
}
