export const timing = Object.freeze({instant:0, short:520, medium:1100, long:1900, evidence:1250, review:1900, read:14, readMax:5200, character:17, comma:70, sentence:140, strike:280, stagger:85, typo:110, frame:24, messageGap:520});
// An evidence card is only useful when it can be read: keep it on screen for its
// own length, never longer than readMax. The AI still decides the pause around it.
export const readWait = (text, base = timing.evidence) => Math.min(timing.readMax, base + String(text ?? '').replace(/\s+/g, ' ').trim().length * timing.read);
export class Playback {
  constructor() { this.speed=1; this.paused=false; this.skipped=false; this.stopped=false; this.motion=matchMedia('(prefers-reduced-motion: reduce)'); }
  get instant() {return this.skipped || this.motion.matches || (typeof document!=='undefined'&&document.hidden);}
  stop(){this.stopped=true;}
  skip(){this.skipped=true;this.paused=false;}
  async wait(ms) {
    let remaining=ms;
    do {
      if(this.stopped)throw new DOMException('Stopped','AbortError');
      if(!this.paused && (this.instant || remaining<=0))return;
      const start=performance.now();
      await new Promise(resolve=>setTimeout(resolve,timing.frame));
      if(!this.paused)remaining-=(performance.now()-start)*this.speed;
    } while(remaining>0 || this.paused);
  }
  async type(node,text,typo=false,onChange=()=>{},protectedTexts=[]) {
    await this.wait(0);
    if(this.instant){node.textContent=text;onChange();return;}
    // Only explicitly safe connective words can receive cosmetic errors.
    const protectedRanges=[];
    for(const value of protectedTexts){if(!value)continue;let at=text.toLocaleLowerCase().indexOf(value.toLocaleLowerCase());while(at!==-1){protectedRanges.push([at,at+value.length]);at=text.toLocaleLowerCase().indexOf(value.toLocaleLowerCase(),at+value.length);}}
    const match = typo ? [...text.matchAll(/\b(?:que|para|uma|com|the|and|with|this)\b/gi)].find(m=>!protectedRanges.some(([a,b])=>m.index>=a&&m.index<b)) : null;
    const at = match ? match.index+1 : -1;
    for(let i=0;i<text.length;i++) {
      await this.wait(0);
      if(this.instant){node.textContent=text;onChange();return;}
      if(i===at){node.textContent=text.slice(0,i)+'x';await this.wait(timing.typo);node.textContent=text.slice(0,i);await this.wait(timing.typo);}
      node.textContent=text.slice(0,i+1);onChange();
      await this.wait(timing.character*(0.8+Math.random()*0.4)+(/[,.!?]/.test(text[i]) ? (text[i]===','?timing.comma:timing.sentence):0));
    }
  }
}
