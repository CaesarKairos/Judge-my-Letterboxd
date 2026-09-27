import {$,plainText} from './utils.js';
import {locale,setLocale,t} from './i18n.js';
import {setupUpload} from './upload.js';
import {judgeExport} from './api.js';
import {loadDemo} from './demo.js';
import {ChatPlayer,typingDots} from './chat-renderer.js';
import {resolvePoster} from './poster-service.js';
let player,script,request,sequence=0,loadingTimer,lastDemo=false;
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
function home(){stop();show('landing');(upload.file?$('#judge'):$('#export')).focus();}
async function play(all=false){
  document.body.classList.toggle('skip-motion',all);
  player?.stop();$('#chat').replaceChildren();$('#ending').hidden=true;
  $('#demo-label').hidden=!script.demo;show('judgment');player=new ChatPlayer($('#chat'),$('#bottom'),$('#announce'));
  $('.chat-heading').setAttribute('tabindex','-1');$('.chat-heading').focus({preventScroll:true});
  if(all)player.clock.skip();const current=player;
  try{await current.play(script);if(current!==player)return;$('#ending').hidden=false;current.reveal();}
  catch(error){if(error.name!=='AbortError'){console.error('Presentation playback failed');$('#error-message').textContent=t('invalid');show('error');}}
}
async function start(demo=false){
  if(!demo&&!upload.file)return;
  stop();lastDemo=demo;const current=sequence;request=new AbortController();show('analyzing');
  $('#loading-dots').replaceChildren(typingDots());const copy=t('loading').split('|');let i=0;$('#loading-copy').textContent=copy[0];
  loadingTimer=setInterval(()=>{$('#loading-copy').textContent=copy[Math.min(++i,copy.length-1)];},2400);
  try{script=await(demo?loadDemo(request.signal):judgeExport(upload.file,locale,request.signal));if(current!==sequence)return;clearInterval(loadingTimer);await play();}
  catch(error){if(current!==sequence)return;clearInterval(loadingTimer);$('#error-message').textContent=t(error.message);if($('#error-message').textContent===error.message)$('#error-message').textContent=t('invalid');show('error');}
}
$('#upload-form').addEventListener('submit',e=>{e.preventDefault();start();});
for(const id of ['demo','error-demo'])$('#'+id).addEventListener('click',()=>start(true));
for(const id of ['cancel','error-back','another'])$('#'+id).addEventListener('click',home);
$('#retry').addEventListener('click',()=>start(lastDemo));
$('#replay').addEventListener('click',()=>play());
$('#show-all').addEventListener('click',()=>play(true));
$('#share').addEventListener('click',async()=>{
  const text=[t('shareTitle'),...script.events.filter(e=>['message','correction'].includes(e.type)).map(e=>e.replacement||plainText(e.segments.map(s=>s.text).join(' ')))].join('\n\n');
  try{if(navigator.share)await navigator.share({title:t('shareTitle'),text});else{await navigator.clipboard.writeText(text);$('#share-status').textContent=t('shared');}}
  catch(error){if(error.name==='AbortError')return;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));a.download='judge-my-letterboxd.txt';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);$('#share-status').textContent=t('download');}
});
if(new URLSearchParams(location.search).get('demo')==='1')start(true);
