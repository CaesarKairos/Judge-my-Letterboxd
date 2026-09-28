import {el} from './utils.js';
import {filmCard,rating} from './poster-service.js';

const button=(text,className='')=>{const node=el('button',className,text);node.type='button';return node;};
const shell=event=>{const section=el('section',`game game-${event.game_type||''}`);section.dataset.event=event.type;section.dataset.gameId=event.game_id||'';section.setAttribute('aria-labelledby',`game-title-${event.game_id}`);return section;};
const skipButton=(event,finish)=>{const skip=button(event.skip_label||'Pular','game-skip');skip.addEventListener('click',()=>finish({skipped:true,key:'skipped'}));return skip;};

function forcedTriage(event){
  const node=shell(event),title=el('h3','game-title','Escolha sem olhar para trás');title.id=`game-title-${event.game_id}`;node.append(title);
  const grid=el('div','game-films'),selects=[];
  for(const film of event.films||[]){
    const card=el('div','game-film');card.append(filmCard(film,{showRating:false}));
    const label=el('label','game-role-label','Papel');
    const select=document.createElement('select');select.setAttribute('aria-label',`Papel para ${film.title}`);
    select.append(new Option('—',''));
    for(const role of event.roles||[])select.append(new Option(role.label,role.id));
    label.append(select);card.append(label);grid.append(card);selects.push({film,select});
  }
  const status=el('p','game-status');status.setAttribute('role','status');
  const actions=el('div','game-actions'),confirm=button(event.confirm_label||'Confirmar','primary');
  let resolve;const done=new Promise(r=>resolve=r),finish=value=>{node.classList.add('game-complete');node.querySelectorAll('button,select').forEach(control=>control.disabled=true);resolve(value);};
  confirm.addEventListener('click',()=>{const values=selects.map(row=>row.select.value),filled=values.every(Boolean),unique=new Set(values).size===values.length;if(!filled||!unique){status.textContent='Cada filme precisa de um papel diferente.';return;}finish({skipped:false,key:'complete',assignments:selects.map(row=>({film_key:row.film.film_key,role_id:row.select.value}))});});
  actions.append(confirm,skipButton(event,finish));node.append(grid,status,actions);
  queueMicrotask(()=>selects[0]?.select.focus({preventScroll:true}));
  return {node,done};
}
function blindRank(event){
  const node=shell(event),title=el('h3','game-title',event.instructions||'Ranqueie sem saber o próximo filme.');title.id=`game-title-${event.game_id}`;node.append(title);
  const stage=el('div','blind-stage'),actions=el('div','blind-actions'),status=el('p','game-status');status.setAttribute('role','status');node.append(stage,actions,status);
  const films=event.films||[],used=new Set(),ranking=[],orders=new Map();let index=0,resolve;
  const done=new Promise(r=>resolve=r),finish=value=>{node.classList.add('game-complete');node.querySelectorAll('button').forEach(control=>control.disabled=true);resolve(value);};
  const draw=()=>{stage.replaceChildren();actions.replaceChildren();if(index>=films.length){finish({skipped:false,key:'ranked',ranking});return;}const film=films[index];stage.append(filmCard(film,{showRating:false}));for(const rank of [1,2,3].filter(value=>!used.has(value))){const b=button(`${rank}º`,'rank-button');b.setAttribute('aria-label',`Colocar ${film.title} em ${rank}º`);b.addEventListener('click',()=>{used.add(rank);orders.set(film.film_key,rank);ranking.push({film_key:film.film_key,rank});index++;draw();});actions.append(b);}actions.append(skipButton(event,finish));actions.querySelector('button')?.focus({preventScroll:true});};
  draw();return {node,done};
}
function defendTake(event){
  const node=shell(event),title=el('h3','game-title',event.question||'Vai sustentar essa?');title.id=`game-title-${event.game_id}`;node.append(title);
  if(event.film)node.append(filmCard(event.film,{showRating:false}));
  if(event.tmdb){const context=el('p','tmdb-context');context.textContent=`${event.tmdb.source_label||'TMDb'}: ${event.tmdb.vote_average?.toFixed?.(1)??event.tmdb.vote_average}/10 · ${event.tmdb.vote_count} votos`;node.append(context);}
  const actions=el('div','game-choice-list');let resolve;const done=new Promise(r=>resolve=r),finish=value=>{node.classList.add('game-complete');node.querySelectorAll('button').forEach(control=>control.disabled=true);resolve(value);};
  for(const choice of event.choices||[]){const b=button(choice.label,'game-choice');b.addEventListener('click',()=>finish({skipped:false,key:choice.id,choice,reaction:choice.reaction||''}));actions.append(b);}
  actions.append(skipButton(event,finish));node.append(actions);queueMicrotask(()=>actions.querySelector('button')?.focus({preventScroll:true}));return {node,done};
}
export function createInteractiveGame(event){
  if(event.type==='game_forced_triage')return forcedTriage(event);
  if(event.type==='game_blind_rank')return blindRank(event);
  if(event.type==='game_defend_take')return defendTake(event);
  return {node:el('div'),done:Promise.resolve({skipped:true,key:'unsupported'})};
}
const blindOutcome=(history,ranking)=>{
  const historical=[...(history||[])].filter(row=>Number.isFinite(row.rating)).sort((a,b)=>b.rating-a.rating).map(row=>row.film_key);
  const chosen=[...(ranking||[])].sort((a,b)=>a.rank-b.rank).map(row=>row.film_key);
  if(historical.length!==chosen.length)return 'complete';
  if(historical.every((key,index)=>key===chosen[index]))return 'match';
  const positions=new Map(historical.map((key,index)=>[key,index])),distance=chosen.reduce((sum,key,index)=>sum+Math.abs((positions.get(key)??index)-index),0);
  return distance<=2?'near_match':'chaotic_mismatch';
};
export function renderGameResult(event,result){
  const node=shell(event);node.classList.add('game-result');
  if(result?.skipped){node.append(el('p','muted','Desafio pulado.'));return node;}
  if(event.reveal_copy)node.append(el('p','game-reveal',event.reveal_copy));
  const history=el('div','game-history');
  for(const film of event.history||[]){const row=el('div','game-history-row');row.append(el('strong','',film.title),rating(film.rating));if(film.rewatches)row.append(el('span','muted',`${film.rewatches} reassistida${film.rewatches===1?'':'s'}`));history.append(row);}node.append(history);
  const key=event.game_type==='blind_rank'?blindOutcome(event.history,result?.ranking):result?.key||'complete';
  const reactions=event.result_reactions||{},reaction=result?.reaction||reactions[key]||reactions.complete||Object.values(reactions)[0]||'';
  if(reaction)node.append(el('p','game-judge-reaction',reaction));
  return node;
}
