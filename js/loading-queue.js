export const loadingVisibleCount=mobile=>mobile?3:4;
export const advanceQueue=track=>{track.firstElementChild?.remove();};
export function createFilmPool(films,random=Math.random){
  let cycle=[],index=0;
  const reshuffle=()=>{cycle=[...films];for(let i=cycle.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[cycle[i],cycle[j]]=[cycle[j],cycle[i]];}index=0;};
  return ()=>{if(index>=cycle.length)reshuffle();return cycle[index++];};
}
