import {$} from './utils.js';
import {locale,setLocale,t} from './i18n.js';
import {setupUpload} from './upload.js';
import {judgeExport} from './api.js';
import {loadDemo} from './demo.js';
import {ChatPlayer,typingDots} from './chat-renderer.js';
let player,script,request,sequence=0,loadingTimer,lastDemo=false;
const upload=setupUpload();
setLocale(locale);$('#locale').value=locale;
$('#locale').addEventListener('change',e=>setLocale(e.target.value));
function show(id){
  document.querySelectorAll('.screen').forEach(n=>n.hidden=n.id!==id);
  $('#landing-nav').hidden=id!=='landing';$('#controls').hidden=id!=='judgment';$('#locale').disabled=id==='judgment'||id==='analyzing';
  $('#bottom').hidden=true;document.body.dataset.screen=id;window.scrollTo(0,0);
  document.querySelector(`#${id} h2`)?.focus({preventScroll:true});
}
function stop(){sequence++;request?.abort();clearInterval(loadingTimer);player?.stop();player=null;}
function home(){stop();show('landing');(upload.file?$('#judge'):$('#export')).focus();}
async function play(all=false){
  document.body.classList.toggle('skip-motion',all);
  player?.stop();$('#chat').replaceChildren();$('#ending').hidden=true;$('#pause').textContent=t('pause');$('#pause').setAttribute('aria-pressed','false');$('#speed').textContent='1×';
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
for(const id of ['restart','replay'])$('#'+id).addEventListener('click',()=>play());
$('#show-all').addEventListener('click',()=>play(true));
$('#pause').addEventListener('click',()=>{if(!player)return;player.clock.paused=!player.clock.paused;$('#pause').textContent=t(player.clock.paused?'resume':'pause');$('#pause').setAttribute('aria-pressed',String(player.clock.paused));});
$('#speed').addEventListener('click',()=>{if(!player)return;player.clock.speed=({1:1.5,1.5:2,2:1})[player.clock.speed];$('#speed').textContent=player.clock.speed+'×';});
$('#skip').addEventListener('click',()=>{player?.clock.skip();$('#pause').textContent=t('pause');$('#pause').setAttribute('aria-pressed','false');document.body.classList.add('skip-motion');});
$('#share').addEventListener('click',async()=>{
  const text=[t('shareTitle'),...script.events.filter(e=>['message','correction'].includes(e.type)).map(e=>e.replacement||e.segments.map(s=>s.text).join(''))].join('\n\n');
  try{if(navigator.share)await navigator.share({title:t('shareTitle'),text});else{await navigator.clipboard.writeText(text);$('#share-status').textContent=t('shared');}}
  catch(error){if(error.name==='AbortError')return;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));a.download='judge-my-letterboxd.txt';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);$('#share-status').textContent=t('download');}
});
if(new URLSearchParams(location.search).get('demo')==='1')start(true);
