import {filmCard} from './poster-service.js';
import {filmsFromExport} from './export-preview.js';
import {advanceQueue,createFilmPool,loadingVisibleCount} from './loading-queue.js';
export {filmsFromExport} from './export-preview.js';
export function startLoadingPreview(file,host){
  let stopped=false,finishing=false,timer=null,track,animation=null;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches,count=loadingVisibleCount(matchMedia('(max-width: 520px)').matches);
  host.replaceChildren();host.dataset.loading='true';
  const card=film=>{const node=filmCard(film,{showRating:false,eager:false});node.dataset.film=`${film.title}|${film.year||''}`;node.querySelectorAll('img').forEach(img=>img.draggable=false);return node;};
  filmsFromExport(file).then(films=>{if(stopped||!films.length)return;const next=createFilmPool(films);track=document.createElement('div');track.className='loading-film-track';track.style.setProperty('--visible',count);for(let i=0;i<count+1;i++)track.append(card(next()));host.append(track);
    const schedule=delay=>{timer=setTimeout(advance,delay);};
    const advance=async()=>{if(stopped||finishing)return;if(reduced){advanceQueue(track);track.append(card(next()));schedule(3200);return;}
      const styles=getComputedStyle(track),step=track.firstElementChild.getBoundingClientRect().width+parseFloat(styles.columnGap||styles.gap||0);
      animation=track.animate([{transform:'translateX(0)'},{transform:`translateX(-${step}px)`}],{duration:650,easing:'cubic-bezier(.4,0,.2,1)',fill:'forwards'});
      try{await animation.finished;}catch{return;}finally{animation=null;}
      if(stopped)return;
      // Cancel removes the filled transform before the DOM is committed. With no CSS transform
      // transition, normalization to zero is atomic and can never animate backwards.
      track.getAnimations().forEach(effect=>effect.cancel());advanceQueue(track);
      if(!finishing)track.append(card(next()));
      if(finishing){track.classList.add('settling');return;}
      schedule(1450);
    };
    schedule(reduced?3200:1200);
  }).catch(()=>{});
  const stop=()=>{stopped=true;clearTimeout(timer);animation?.cancel();host.replaceChildren();delete host.dataset.loading;};stop.finish=()=>{finishing=true;host.dataset.loading='ready';clearTimeout(timer);if(!animation)track?.classList.add('settling');};return stop;
}
