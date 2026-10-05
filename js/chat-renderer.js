import {el,types,parseMarkup} from './utils.js';
import {t} from './i18n.js';
import {Playback,timing,readWait} from './animations.js';
import {renderAttachment,filmStrip} from './event-renderer.js';
import {disconnectPosters,inlineRating} from './poster-service.js';
import {blindRankOutcome,forcedTriageReaction} from './game-results.js';
export function typingDots(){const node=el('div','typing');node.setAttribute('aria-label',t('typing'));for(let i=0;i<3;i++){const dot=el('span');dot.setAttribute('aria-hidden','true');node.append(dot);}return node;}
export class ChatPlayer {
  constructor(container,bottom,announce) {
    this.container=container;this.bottom=bottom;this.announce=announce;this.clock=new Playback();this.follow=true;this.programmaticScroll=false;this.lastScrollY=scrollY;
    this.scroll=()=>{if(this.programmaticScroll){this.lastScrollY=scrollY;return;}const distance=document.documentElement.scrollHeight-innerHeight-scrollY;if(scrollY<this.lastScrollY-2)this.follow=false;else if(distance<80)this.follow=true;this.lastScrollY=scrollY;bottom.hidden=this.follow;};
    this.onWheel=e=>{if(e.deltaY<0){this.follow=false;bottom.hidden=false;}};
    this.onKey=e=>{if(['ArrowUp','PageUp','Home'].includes(e.key)){this.follow=false;bottom.hidden=false;}};
    this.onTouch=e=>{this.touchY=e.touches[0]?.clientY;};
    this.onMove=e=>{if(e.touches[0]?.clientY>this.touchY){this.follow=false;bottom.hidden=false;}};
    this.onPointer=()=>{this.programmaticScroll=false;clearTimeout(this.programmaticTimer);};
    window.addEventListener('scroll',this.scroll,{passive:true});window.addEventListener('wheel',this.onWheel,{passive:true});window.addEventListener('keydown',this.onKey);window.addEventListener('touchstart',this.onTouch,{passive:true});window.addEventListener('touchmove',this.onMove,{passive:true});window.addEventListener('pointerdown',this.onPointer,{passive:true});
    this.jump=()=>{this.follow=true;bottom.hidden=true;this.reveal(true);};bottom.addEventListener('click',this.jump);
    this.resize=new ResizeObserver(()=>this.reveal());this.resize.observe(container);
  }
  reveal(smooth=false){if(this.follow){this.programmaticScroll=true;clearTimeout(this.programmaticTimer);window.scrollTo({top:document.documentElement.scrollHeight,behavior:smooth&&!this.clock.instant?'smooth':'instant'});this.programmaticTimer=setTimeout(()=>{this.programmaticScroll=false;this.lastScrollY=scrollY;},smooth&&!this.clock.instant?900:50);}}
  append(node){this.container.append(node);this.reveal();}
  stop(){this.clock.stop();clearTimeout(this.programmaticTimer);this.resize.disconnect();disconnectPosters();window.removeEventListener('scroll',this.scroll);window.removeEventListener('wheel',this.onWheel);window.removeEventListener('keydown',this.onKey);window.removeEventListener('touchstart',this.onTouch);window.removeEventListener('touchmove',this.onMove);window.removeEventListener('pointerdown',this.onPointer);this.bottom.removeEventListener('click',this.jump);}
  async speak(event) {
    const segments=event.segments||[{text:event.type==='correction'?event.replacement:event.text,effect:event.type}];
    // Markup becomes elements before typing: a blockquote is never played as `<blockquote>`.
    const runs=[];
    for(const segment of segments) {
      if(segment?.kind==='rating'){runs.push({kind:'rating',rating:segment.rating,title:segment.title,parts:[{type:'rating',text:''}]});continue;}
      const effect=segment.effect||'none',parts=parseMarkup(segment.text??'');
      if(parts.length)runs.push({effect,parts});
    }
    const quoted=runs.some(run=>run.effect==='quote'||run.parts.some(part=>part.type==='blockquote'));
    const paragraph=el('p',`judge-message ${event.role==='archetype_phrase'?'archetype':''}`);
    const host=quoted?el('div','judge-block'):paragraph;host.dataset.event=event.type;
    this.append(host);
    let cursor=quoted?null:paragraph;
    for(const run of runs) for(const part of run.parts) {
      if(run.kind==='rating'){if(!cursor){cursor=el('p',`judge-message ${event.role==='archetype_phrase'?'archetype':''}`);host.append(cursor);}cursor.append(inlineRating(run.rating,run.title));continue;}
      const quote=run.effect==='quote'||part.type==='blockquote';
      let span;
      if(quote){span=el('blockquote','judge-quote');host.append(span);cursor=null;}
      else {
        if(!cursor){cursor=el('p',`judge-message ${event.role==='archetype_phrase'?'archetype':''}`);host.append(cursor);}
        const effect=run.effect==='none'?'normal':run.effect;
        span=part.type==='strong'||effect==='bold'?el('strong'):part.type==='em'||effect==='italic'?el('em'):effect==='strike'?el('del'):el('span',effect==='correction'?'correction':`judge-run judge-run-${effect}`);
        cursor.append(span);
      }
      const cosmetic=event.type==='message'&&!event.role&&!event.cue&&run.effect==='none'&&Math.random()<0.075;
      await this.clock.type(span,part.text,cosmetic,()=>this.reveal(),this.protectedTexts);
      if(run.effect==='wave'&&part.text.length<=40&&!this.clock.instant){span.replaceChildren(...[...part.text].map((character,index)=>{const letter=el('span','judge-wave-letter',character);letter.style.setProperty('--wave-index',index);return letter;}));}
      if(run.effect==='strike'){await this.clock.wait(timing.short);span.classList.add('struck');await this.clock.wait(timing.strike);}
    }
    this.announce.textContent=host.textContent;await this.clock.wait(timing.messageGap);
  }
  async game(event){
    const card=el('section','game-card');card.dataset.event=event.type;card.setAttribute('aria-label','Interactive challenge');
    const copy=event.copy||{},films=event.films||[],body=el('div','game-body'),actions=el('div','game-actions'),skip=el('button','game-skip',t('skip')||'Pular');skip.type='button';card.append(body,actions);this.append(card);
    await new Promise(resolve=>{
      let done=false,resultText='';const finish=skipped=>{if(done)return;done=true;body.replaceChildren();if(!skipped){body.append(filmStrip(films));if(event.tmdb?.sample_sufficient)body.append(el('p','game-source',`${event.external_source_label||'média do público no TMDb'}: ${event.tmdb.vote_average} (${event.tmdb.vote_count} votos)`));body.append(el('p','game-result',resultText||copy.reveal_copy||'Escolhas registradas. Agora as notas voltam para a sala.'));}else body.append(el('p','game-result','Desafio pulado.'));actions.replaceChildren();resolve();};
      skip.addEventListener('click',()=>finish(true));actions.append(skip);
      if(event.type==='game_defend_take'){body.append(el('p','game-question',copy.question||'Vai sustentar essa escolha?'));const choices=el('div','defend-choices');for(const choice of copy.choices||[{id:'keep',label:'Mantenho.'},{id:'reconsider',label:'Talvez eu tenha pesado.'}]){const button=el('button','game-choice-card',choice.label);button.type='button';button.setAttribute('aria-pressed','false');button.addEventListener('click',()=>{button.setAttribute('aria-pressed','true');copy.reveal_copy=choice.reaction||'';finish(false);});choices.append(button);}body.append(choices);return;}
      if(event.type==='game_blind_rank'){const used=new Set(),ranks=[],placed=new Map(),live=el('p','sr-only');live.setAttribute('aria-live','polite');let index=0;const show=()=>{body.replaceChildren();const progress=el('p','game-progress',`${index+1} / ${films.length}`),slots=el('div','rank-slots');for(let rank=1;rank<=3;rank++){const button=el('button','rank-slot');button.type='button';button.dataset.rank=rank;button.disabled=used.has(rank);button.setAttribute('aria-label',used.has(rank)?`${rank}º ocupado por ${placed.get(rank).title}`:`Colocar ${films[index].title} em ${rank}º`);button.append(el('strong','',`${rank}º`));if(used.has(rank))button.append(filmStrip([placed.get(rank)],false,{showRating:false}));else button.append(el('span','rank-empty','vazio'));button.addEventListener('click',()=>{used.add(rank);ranks.push(rank);placed.set(rank,films[index]);button.classList.add('slot-filled');live.textContent=`${films[index].title} confirmado em ${rank}º.`;if(++index===films.length){const outcome=blindRankOutcome(ranks,films);body.replaceChildren(el('p','game-reveal-title',copy.reveal_copy||'Seu ranking, agora com as notas:'),slots);for(const slot of slots.children){const film=placed.get(Number(slot.dataset.rank));slot.disabled=true;slot.replaceChildren(el('strong','',`${slot.dataset.rank}º`),filmStrip([film]));}resultText=copy.result_reactions?.[outcome]||'';actions.replaceChildren();if(resultText)body.append(el('p','game-result',resultText));done=true;resolve();}else setTimeout(show,this.clock.instant?0:220);});slots.append(button);}const active=el('div','rank-active');active.append(el('p','game-instructions',copy.instructions||'Escolha um slot sem ver o próximo.'),filmStrip([films[index]],false,{showRating:false}));body.append(progress,slots,active,live);slots.querySelector('button:not(:disabled)')?.focus();};show();return;}
      const roles=copy.roles,assignments=new Map(),picker=el('div','triage-films'),zones=el('div','triage-roles'),live=el('p','sr-only');picker.setAttribute('aria-label','Filmes disponíveis');zones.setAttribute('aria-label','Papéis');live.setAttribute('aria-live','polite');let selected=null;
      const confirm=el('button','game-confirm',copy.confirm_label||'Confirmar');confirm.type='button';confirm.disabled=true;
      const filmButton=film=>{const button=el('button','triage-film');button.type='button';button.dataset.filmId=film.film_id||film.film_key;button.setAttribute('aria-label',film.title);button.append(filmStrip([film],false,{showRating:false}));button.querySelectorAll('img').forEach(img=>img.draggable=false);let preview=null;const choose=()=>{selected=film;card.querySelectorAll('.triage-film').forEach(node=>node.classList.toggle('selected',node.dataset.filmId===(film.film_id||film.film_key)));};button.addEventListener('click',choose);button.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();choose();}});button.addEventListener('pointerdown',event=>{choose();button.setPointerCapture?.(event.pointerId);button.classList.add('dragging');preview=button.cloneNode(true);preview.className='triage-drag-preview';preview.setAttribute('aria-hidden','true');document.body.append(preview);preview.style.left=`${event.clientX}px`;preview.style.top=`${event.clientY}px`;});button.addEventListener('pointermove',event=>{if(!preview)return;preview.style.left=`${event.clientX}px`;preview.style.top=`${event.clientY}px`;const target=document.elementFromPoint?.(event.clientX,event.clientY)?.closest?.('.triage-role');card.querySelectorAll('.triage-role').forEach(zone=>zone.classList.toggle('drop-target',zone===target));});button.addEventListener('pointerup',event=>{button.classList.remove('dragging');preview?.remove();preview=null;const target=document.elementFromPoint?.(event.clientX,event.clientY)?.closest?.('.triage-role');card.querySelectorAll('.triage-role').forEach(zone=>zone.classList.remove('drop-target'));if(target)assign(target.dataset.roleId);});return button;};
      const render=()=>{picker.replaceChildren();for(const film of films)if(![...assignments.values()].some(value=>(value.film_id||value.film_key)===(film.film_id||film.film_key)))picker.append(filmButton(film));zones.replaceChildren();for(const role of roles){const zone=el('button','triage-role');zone.type='button';zone.dataset.roleId=role.id;zone.append(el('strong','',role.label));const film=assignments.get(role.id);if(film)zone.append(filmStrip([film],false,{showRating:false}));else zone.append(el('span','triage-drop',copy.instructions||'Arraste ou escolha um filme'));zone.addEventListener('click',()=>{if(selected)assign(role.id);else if(film){selected=film;assignments.delete(role.id);live.textContent=`${film.title} removido de ${role.label}. Escolha outro papel.`;render();}});zone.addEventListener('pointerenter',()=>zone.classList.add('drop-target'));zone.addEventListener('pointerleave',()=>zone.classList.remove('drop-target'));zones.append(zone);}confirm.disabled=assignments.size!==3;};
      const assign=roleId=>{if(!selected)return;for(const [id,film] of assignments)if((film.film_id||film.film_key)===(selected.film_id||selected.film_key))assignments.delete(id);assignments.set(roleId,selected);live.textContent=`${selected.title} movido para ${roles.find(role=>role.id===roleId)?.label}.`;selected=null;render();};
      confirm.addEventListener('click',()=>{const chosen=roles.map(role=>({film:assignments.get(role.id),film_key:assignments.get(role.id)?.film_key,film_id:assignments.get(role.id)?.film_id,role_id:role.id,rank:role.rank}));body.replaceChildren();const results=el('div','triage-results'),reactions=[];for(const item of chosen){const result=el('section','triage-result');result.append(el('strong','',roles.find(role=>role.id===item.role_id).label),filmStrip([item.film]));results.append(result);const hint=(copy.reaction_hints||[]).find(row=>(row.film_id||row.film_key)===(item.film_id||item.film_key)&&row.role_id===item.role_id);if(hint?.text&&!reactions.includes(hint.text))reactions.push(hint.text);}body.append(results);for(const text of reactions.slice(0,2))body.append(el('p','game-result',text));actions.replaceChildren();done=true;resolve();});
      body.append(picker,zones,live);actions.prepend(confirm);render();
    });
    await this.clock.wait(timing.medium);this.reveal();
  }
  async play(script) {
    this.protectedTexts=[];
    const collect=value=>{if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){if(['title','name','handle','display_name','tag','related_tag','phrase','archetype_text'].includes(key)&&typeof item==='string')this.protectedTexts.push(item);else if(typeof item==='object')collect(item);}};
    collect(script);
    const favorites=script.opening?.top_four||[];
    for(const event of script.events){
      await this.clock.wait(0);if(!types.has(event.type))continue;
      if(event.type==='typing'){const dots=typingDots();this.append(dots);await this.clock.wait(timing[event.duration]??timing.short);dots.remove();}
      else if(event.type==='pause')await this.clock.wait(timing[event.duration]??timing.short);
      else if(['message','strike','correction','game_intro','game_result'].includes(event.type))await this.speak(event);
      else if(['game_forced_triage','game_blind_rank','game_defend_take'].includes(event.type))await this.game(event);
      else {const node=renderAttachment(event);if(node){this.append(node);await this.clock.wait(readWait(node.textContent,event.type==='review_quote'?timing.review:timing.evidence));}}
      if(event.cue==='top_four_reveal'&&favorites.length){
        const group=el('section','favorites');group.append(el('p','eyebrow',t('favorites')),filmStrip(favorites,true));this.append(group);await this.clock.wait(timing.medium);
      }
    }
    await this.clock.wait(timing.medium);
  }
}
