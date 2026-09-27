import {el,types} from './utils.js';
import {t} from './i18n.js';
import {Playback,timing} from './animations.js';
import {renderAttachment,filmStrip} from './event-renderer.js';
import {disconnectPosters} from './poster-service.js';
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
    const line=el('p',`judge-message ${event.role==='archetype_phrase'?'archetype':''}`);line.dataset.event=event.type;this.append(line);
    const segments=event.segments||[{text:event.type==='correction'?event.replacement:event.text,effect:event.type}];
    for(const segment of segments){
      const effect=segment.effect||'none', span=el(effect==='strike'?'del':'span',effect==='correction'?'correction':'');line.append(span);
      const cosmetic=event.type==='message'&&!event.role&&!event.cue&&effect==='none'&&Math.random()<0.075;
      await this.clock.type(span,segment.text||'',cosmetic,()=>this.reveal(),this.protectedTexts);
      if(effect==='strike'){await this.clock.wait(timing.short);span.classList.add('struck');await this.clock.wait(timing.strike);}
    }
    this.announce.textContent=line.textContent;await this.clock.wait(timing.messageGap);
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
      else if(['message','strike','correction'].includes(event.type))await this.speak(event);
      else {const node=renderAttachment(event);if(node){this.append(node);await this.clock.wait(timing.short);}}
      if(event.cue==='top_four_reveal'&&favorites.length){
        const group=el('section','favorites');group.append(el('p','eyebrow',t('favorites')),filmStrip(favorites,true));this.append(group);await this.clock.wait(timing.medium);
      }
    }
    await this.clock.wait(timing.medium);
  }
}
