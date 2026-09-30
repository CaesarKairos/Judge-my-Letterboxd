import {$,plainText} from './utils.js';
import {locale,setLocale,t} from './i18n.js';
import {setupUpload} from './upload.js';
import {judgeExport} from './api.js';
import {loadDemo} from './demo.js';
import {ChatPlayer,typingDots} from './chat-renderer.js';
import {resolvePoster} from './poster-service.js';
import {makeShareCards,downloadCard} from './share-cards.js';
let player,script,request,sequence=0,loadingTimer,lastDemo=false,lastFailure=null,shareFormat='post';
const upload=setupUpload();
setLocale(locale);
const languageMenu=$('#language-menu'),languageSummary=languageMenu.querySelector('summary'),languageOptions=[...languageMenu.querySelectorAll('[data-locale]')];
function chooseLocale(value,focus=false){setLocale(value);$('#language-label').textContent=value==='pt-BR'?'PT':'EN';languageOptions.forEach(option=>option.setAttribute('aria-selected',String(option.dataset.locale===value)));languageMenu.open=false;if(focus)languageSummary.focus();}
chooseLocale(locale);
languageOptions.forEach((option,index)=>{option.addEventListener('click',()=>chooseLocale(option.dataset.locale,true));option.addEventListener('keydown',event=>{if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const target=event.key==='Home'?0:event.key==='End'?languageOptions.length-1:(index+(event.key==='ArrowDown'?1:-1)+languageOptions.length)%languageOptions.length;languageOptions[target].focus();}if(event.key==='Escape'){event.preventDefault();languageMenu.open=false;languageSummary.focus();}});});
document.addEventListener('click',event=>{if(!languageMenu.contains(event.target))languageMenu.open=false;});
const landingFilms=[['Portrait of a Lady on Fire','2019'],['Moonlight','2016'],['The Grand Budapest Hotel','2014'],['Spirited Away','2001'],['The Handmaiden','2016'],['Fantastic Mr. Fox','2009'],['The Shining','1980'],['In the Mood for Love','2000'],['Aftersun','2022'],['The Worst Person in the World','2021'],['Paris, Texas','1984'],['Perfect Blue','1997']].map(([title,year])=>({title,year}));
const shuffled=list=>{const copy=[...list];for(let i=copy.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[copy[i],copy[j]]=[copy[j],copy[i]];}return copy;};
async function decorateLanding(){
  const chosen=shuffled(landingFilms).slice(0,3);
  for(const [index,node] of [...document.querySelectorAll('.art-poster')].entries()){
    const film=chosen[index];if(!film)return;
    node.querySelector('figcaption').textContent=`${film.title} · ${film.year}`;
    const img=node.querySelector('img'),url=await resolvePoster(film);
    if(!url){img.remove();continue;}
    img.addEventListener('load',()=>node.classList.add('resolved'),{once:true});
    img.addEventListener('error',()=>img.remove(),{once:true});
    img.src=url;
  }
}
decorateLanding();
function show(id){
  document.querySelectorAll('.screen').forEach(n=>n.hidden=n.id!==id);
  $('#landing-nav').hidden=id!=='landing';languageMenu.hidden=id==='judgment'||id==='analyzing';
  $('#bottom').hidden=true;document.body.dataset.screen=id;window.scrollTo(0,0);
  document.querySelector(`#${id} h2`)?.focus({preventScroll:true});
}
function stop(){sequence++;request?.abort();clearInterval(loadingTimer);player?.stop();player=null;}
async function renderEnding(){
  const review=$('#profile-review'),profile=script.profile_review;
  const fullReview=profile?.full||profile?.text;review.replaceChildren();review.hidden=!fullReview;
  if(fullReview){const lead=document.createElement('p');lead.className='eyebrow';lead.textContent=profile.lead||t('profileReview');const card=document.createElement('article');card.className='profile-review-card';const title=document.createElement('h3');title.textContent=t('profileReview');const body=document.createElement('p');body.textContent=fullReview;card.append(title,body);review.append(lead,card);}
  const explain=$('#explainability'),details=script.explainability;
  explain.hidden=!details;if(details){const lines=[details.summary,...(details.findings||[])].filter(Boolean);$('#explainability-copy').textContent=lines.join('\n\n');}
  const cards=$('#share-cards'),previews=$('#share-card-previews');previews.replaceChildren();cards.hidden=!fullReview;
  if(fullReview){const posterUrls=await Promise.all((script.opening?.top_four||[]).map(resolvePoster)),rendered=await makeShareCards(script,{posterUrls,format:shareFormat});for(const [name,canvas] of Object.entries(rendered)){const item=document.createElement('div');item.className='share-preview';item.append(canvas);const download=document.createElement('button');download.textContent=t('downloadCard');download.addEventListener('click',()=>downloadCard(canvas,`judge-${name}-${shareFormat}`));const share=document.createElement('button');share.textContent=t('shareCard');share.addEventListener('click',async()=>{canvas.toBlob(async blob=>{const file=new File([blob],`judge-${name}-${shareFormat}.png`,{type:'image/png'});if(navigator.canShare?.({files:[file]}))await navigator.share({files:[file],title:t('shareTitle')});else downloadCard(canvas,`judge-${name}-${shareFormat}`);},'image/png');});item.append(download,share);previews.append(item);}}
}
function home(){stop();show('landing');(upload.file?$('#judge'):$('#export')).focus();}
async function play(all=false){
  document.body.classList.toggle('skip-motion',all);
  player?.stop();$('#chat').replaceChildren();$('#ending').hidden=true;
  $('#demo-label').hidden=!script.demo;show('judgment');let notice=$('#partial-notice');if(!notice){notice=document.createElement('p');notice.id='partial-notice';notice.className='muted';$('#chat').before(notice);}notice.hidden=script.render?.ai_generation!=='partial';notice.textContent=t('partialNotice');player=new ChatPlayer($('#chat'),$('#bottom'),$('#announce'));
  $('.chat-heading').setAttribute('tabindex','-1');$('.chat-heading').focus({preventScroll:true});
  if(all)player.clock.skip();const current=player;
  try{await current.play(script);if(current!==player)return;await renderEnding();$('#ending').hidden=false;current.reveal();}
  catch(error){if(error.name!=='AbortError'){console.error('Presentation playback failed');$('#error-message').textContent=t('invalid');show('error');}}
}
async function start(demo=false){
  if(!demo&&!upload.file)return;
  stop();lastDemo=demo;const current=sequence;request=new AbortController();show('analyzing');
  $('#loading-dots').replaceChildren(typingDots());const copy=t('loading').split('|');let i=0;$('#loading-copy').textContent=copy[0];
  loadingTimer=setInterval(()=>{$('#loading-copy').textContent=copy[Math.min(++i,copy.length-1)];},2400);
  try{script=await(demo?loadDemo(request.signal):judgeExport(upload.file,locale,request.signal));if(current!==sequence)return;lastFailure=null;$('#local-analysis').hidden=true;clearInterval(loadingTimer);await play();}
  catch(error){if(current!==sequence)return;clearInterval(loadingTimer);lastFailure=error.payload||null;$('#local-analysis').hidden=!(error.message==='aiUnavailable'&&lastFailure?.deterministic_analysis_available);$('#error-message').textContent=t(error.message);if($('#error-message').textContent===error.message)$('#error-message').textContent=t('invalid');show('error');}
}
$('#upload-form').addEventListener('submit',e=>{e.preventDefault();start();});
for(const id of ['demo','error-demo'])$('#'+id).addEventListener('click',()=>start(true));
for(const id of ['cancel','error-back','another'])$('#'+id).addEventListener('click',home);
$('#retry').addEventListener('click',()=>start(lastDemo));
$('#local-analysis').addEventListener('click',async()=>{
  if(!lastFailure?.analysis)return;
  const stats=lastFailure.analysis.stats||[];
  script={version:'presentation-v1',demo:false,events:[{type:'message',segments:[{text:locale==='pt-BR'?'Aqui está o que o export mostrou sem texto do Judge.':'Here is what the export showed without the Judge.'}]},{type:'profile_stats',stats}],opening:{top_four:[]}};
  await play();
});
$('#replay').addEventListener('click',()=>play());
$('#show-all').addEventListener('click',()=>play(true));
$('#share').addEventListener('click',async()=>{
  const canvases=[...document.querySelectorAll('#share-card-previews canvas')];if(!canvases.length)return;
  const files=await Promise.all(canvases.map((canvas,index)=>new Promise(resolve=>canvas.toBlob(blob=>resolve(new File([blob],`judge-${index+1}.png`,{type:'image/png'})),'image/png'))));
  try{if(navigator.canShare?.({files}))await navigator.share({title:t('shareTitle'),files});else{canvases.forEach((canvas,index)=>downloadCard(canvas,`judge-${index+1}`));$('#share-status').textContent=t('download');}}
  catch(error){if(error.name!=='AbortError'){$('#share-status').textContent=t('download');canvases.forEach((canvas,index)=>downloadCard(canvas,`judge-${index+1}`));}}
});
document.querySelectorAll('[data-share-format]').forEach(button=>button.addEventListener('click',async()=>{shareFormat=button.dataset.shareFormat;document.querySelectorAll('[data-share-format]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));await renderEnding();}));
if(new URLSearchParams(location.search).get('demo')==='1')start(true);
