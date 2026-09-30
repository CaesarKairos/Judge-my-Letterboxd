import {el,types,parseMarkup} from './utils.js';
import {t} from './i18n.js';
import {Playback,timing,readWait} from './animations.js';
import {renderAttachment,filmStrip} from './event-renderer.js';
import {disconnectPosters} from './poster-service.js';
import {blindRankOutcome,forcedTriageReaction} from './game-results.js';
export function typingDots(){const node=el('div','typing');node.setAttribute('aria-label',t('typing'));for(let i=0;i<3;i++){const dot=el('span');dot.setAttribute('aria-hidden','true');node.append(dot);}return node;}
export class ChatPlayer {
  constructor(container,bottom,announce) {
    this.container=container;this.bottom=bottom;this.announce=announce;this.clock=new Playback();this.follow=true;
    this.scroll=()=>{const distance=document.documentElement.scrollHeight-innerHeight-scrollY;this.follow=distance<150;bottom.hidden=this.follow;};
    this.onWheel=e=>{if(e.deltaY<0){this.follow=false;bottom.hidden=false;}};
    this.onKey=e=>{if(['ArrowUp','PageUp','Home'].includes(e.key)){this.follow=false;bottom.hidden=false;}};
    this.onTouch=e=>{this.touchY=e.touches[0]?.clientY;};
    this.onMove=e=>{if(e.touches[0]?.clientY>this.touchY){this.follow=false;bottom.hidden=false;}};
    window.addEventListener('scroll',this.scroll,{passive:true});window.addEventListener('wheel',this.onWheel,{passive:true});window.addEventListener('keydown',this.onKey);window.addEventListener('touchstart',this.onTouch,{passive:true});window.addEventListener('touchmove',this.onMove,{passive:true});
    this.jump=()=>{this.follow=true;bottom.hidden=true;this.reveal(true);};bottom.addEventListener('click',this.jump);
    this.resize=new ResizeObserver(()=>this.reveal());this.resize.observe(container);
  }
  reveal(smooth=false){if(this.follow)window.scrollTo({top:document.documentElement.scrollHeight,behavior:smooth&&!this.clock.instant?'smooth':'instant'});}
  append(node){this.container.append(node);this.reveal();}
  stop(){this.clock.stop();this.resize.disconnect();disconnectPosters();window.removeEventListener('scroll',this.scroll);window.removeEventListener('wheel',this.onWheel);window.removeEventListener('keydown',this.onKey);window.removeEventListener('touchstart',this.onTouch);window.removeEventListener('touchmove',this.onMove);this.bottom.removeEventListener('click',this.jump);}
  async speak(event) {
    const segments=event.segments||[{text:event.type==='correction'?event.replacement:event.text,effect:event.type}];
    // Markup becomes elements before typing: a blockquote is never played as `<blockquote>`.
    const runs=[];
    for(const segment of segments) {
      const effect=segment.effect||'none',parts=parseMarkup(segment.text??'');
      if(parts.length)runs.push({effect,parts});
    }
    const quoted=runs.some(run=>run.effect==='quote'||run.parts.some(part=>part.type==='blockquote'));
    const paragraph=el('p',`judge-message ${event.role==='archetype_phrase'?'archetype':''}`);
    const host=quoted?el('div','judge-block'):paragraph;host.dataset.event=event.type;
    this.append(host);
    let cursor=quoted?null:paragraph;
    for(const run of runs) for(const part of run.parts) {
      const quote=run.effect==='quote'||part.type==='blockquote';
      let span;
      if(quote){span=el('blockquote','judge-quote');host.append(span);cursor=null;}
      else {
        if(!cursor){cursor=el('p',`judge-message ${event.role==='archetype_phrase'?'archetype':''}`);host.append(cursor);}
        span=part.type==='strong'?el('strong'):part.type==='em'?el('em'):run.effect==='strike'?el('del'):el('span',run.effect==='correction'?'correction':'');
        cursor.append(span);
      }
      const cosmetic=event.type==='message'&&!event.role&&!event.cue&&run.effect==='none'&&Math.random()<0.075;
      await this.clock.type(span,part.text,cosmetic,()=>this.reveal(),this.protectedTexts);
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
      if(event.type==='game_defend_take'){body.append(el('p','game-question',copy.question||'Vai sustentar essa escolha?'));for(const choice of copy.choices||[{id:'keep',label:'Mantenho.'},{id:'reconsider',label:'Talvez eu tenha pesado.'}]){const button=el('button','game-choice',choice.label);button.type='button';button.addEventListener('click',()=>{copy.reveal_copy=choice.reaction||'';finish(false);});actions.prepend(button);}return;}
      if(event.type==='game_blind_rank'){const used=new Set(),ranks=[];let index=0;const show=()=>{body.replaceChildren();body.append(el('p','game-instructions',copy.instructions||'Coloque em 1º, 2º ou 3º sem saber o próximo.'));body.append(filmStrip([{...films[index],rating:null}]));const select=el('select','game-select');select.setAttribute('aria-label','Posição');select.append(new Option('Escolha a posição',''));for(let rank=1;rank<=3;rank++)if(!used.has(rank))select.append(new Option(`${rank}º`,String(rank)));const next=el('button','game-confirm',index===2?'Confirmar':'Próximo');next.type='button';next.disabled=true;select.addEventListener('change',()=>next.disabled=!select.value);next.addEventListener('click',()=>{const rank=Number(select.value);used.add(rank);ranks.push(rank);if(++index===films.length){const outcome=blindRankOutcome(ranks,films);resultText=copy.result_reactions?.[outcome]||copy.reveal_copy||outcome;finish(false);}else show();});body.append(select,next);select.focus();};show();return;}
      body.append(filmStrip(films.map(film=>({...film,rating:null}))));const roles=copy.roles?.length===3?copy.roles:[{id:'high',rank:3,label:'Fica'},{id:'mid',rank:2,label:'Defende'},{id:'low',rank:1,label:'Sai'}],selects=[];for(const film of films){const select=el('select','game-select');select.setAttribute('aria-label',`Papel para ${film.title}`);select.append(new Option('Escolha um papel',''));for(const role of roles)select.append(new Option(role.label,role.id));selects.push(select);body.append(select);}const confirm=el('button','game-confirm',copy.confirm_label||'Confirmar');confirm.type='button';confirm.disabled=true;const check=()=>confirm.disabled=selects.some(select=>!select.value)||new Set(selects.map(select=>select.value)).size!==selects.length;selects.forEach(select=>select.addEventListener('change',check));confirm.addEventListener('click',()=>{const assignments=selects.map((select,index)=>{const role=roles.find(row=>row.id===select.value);return {film_key:films[index].film_key,role_id:role.id,rank:role.rank};});resultText=forcedTriageReaction(assignments,copy.reaction_hints||[]);finish(false);});actions.prepend(confirm);
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
