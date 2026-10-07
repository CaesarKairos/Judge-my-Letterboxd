import {$,plainText,appendRich,richPlainText,validateScript} from './utils.js';
import {locale,setLocale,t} from './i18n.js';
import {setupUpload} from './upload.js';
import {judgeExport} from './api.js';
import {loadDemo} from './demo.js';
import {ChatPlayer} from './chat-renderer.js';
import {resolvePoster,filmCard} from './poster-service.js';
import {makeShareCards,downloadCard} from './share-cards.js';
import {startLoadingPreview} from './loading-preview.js';
let player,script,request,sequence=0,loadingTimer,stopLoadingPreview,lastDemo=false,lastFailure=null,shareFormat='post';
const upload=setupUpload();
setLocale(locale);
const languageMenu=$('#language-menu'),languageSummary=languageMenu.querySelector('summary'),languageOptions=[...languageMenu.querySelectorAll('[data-locale]')];
function chooseLocale(value,focus=false){setLocale(value);$('#language-label').textContent=value==='pt-BR'?'PT':'EN';languageOptions.forEach(option=>option.setAttribute('aria-selected',String(option.dataset.locale===value)));languageMenu.open=false;if(focus)languageSummary.focus();}
chooseLocale(locale);
fetch('/api/judge').then(response=>response.ok?response.json():null).then(info=>{if(info?.pipeline==='freeform')document.querySelector('.privacy').textContent=t('freeformPrivacy');}).catch(()=>{});
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
function stop(){sequence++;request?.abort();clearInterval(loadingTimer);stopLoadingPreview?.();stopLoadingPreview=null;player?.stop();player=null;}
// Local and development runs may show which stage failed; production keeps the screen clean.
// Only curated fields travel here: never a key, a prompt or a stack trace.
const developerMode=()=>['localhost','127.0.0.1',''].includes(location.hostname)||new URLSearchParams(location.search).get('debug')==='1';
function renderTechnicalDetails(reason,payload){
  const box=$('#error-details'),copy=$('#error-details-copy');
  const stage=payload?.stage||({analystUnavailable:'analyst',writerUnavailable:'writer',aiUnavailable:'writer'}[reason]||''),
    attempts=Array.isArray(payload?.attempts)?payload.attempts:[],visible=developerMode()&&Boolean(payload)&&Boolean(stage||attempts.length);
  box.hidden=!visible;copy.textContent='';
  if(!visible)return;
  const lines=[`${t('technicalStage')}: ${stage||'unknown'}`,`${t('technicalAttempts')}: ${attempts.length}`,`${t('technicalReason')}: ${payload.reason||payload.error||reason}`];
  const summary=payload.validation_summary;
  if(summary&&Number.isFinite(summary.moments_received))lines.push(`${t('technicalMoments')}: ${summary.moments_valid||0}/${summary.moments_received}`);
  for(const row of attempts)lines.push(`${row.repair?'repair':'main'} ${row.model||'unknown'}: HTTP ${row.status??0}, finish ${row.finishReason||'-'}, schema ${row.schema===true?'yes':row.schema===false?'no':'n/a'}${row.reason?`, reason ${row.reason}`:''}${row.retry_action?`, retry ${row.retry_action}`:''}${row.action?`, action ${row.action}`:''}${row.provider_error?.status?`, provider ${row.provider_error.status}`:''}${row.provider_error?.message_category?`, category ${row.provider_error.message_category}`:''}`);
  copy.textContent=lines.join('\n');
}
async function renderEnding(){
  $('#ending h2').textContent=script.ending?.title||t('done');
  const review=$('#profile-review'),profile=script.profile_review;
  const fullReview=profile?.text,reviewText=richPlainText(fullReview);review.replaceChildren();review.hidden=!reviewText;
  if(reviewText){const leadText=profile.lead||'',card=document.createElement('article');card.className='profile-review-card';const title=document.createElement('h3');title.textContent=t('profileReview');const body=document.createElement('div');body.className='profile-review-body';appendRich(body,fullReview,{profile:true});if(leadText&&leadText.toLocaleLowerCase()!==t('profileReview').toLocaleLowerCase()){const lead=document.createElement('p');lead.className='eyebrow';lead.textContent=leadText;review.append(lead);}card.append(title,body);review.append(card);}
  const explain=$('#explainability'),details=script.explainability;
  explain.hidden=!details;if(details){const lines=[details.summary,...(details.findings||[])].filter(Boolean);$('#explainability-copy').textContent=lines.join('\n\n');}
  const cards=$('#share-cards'),previews=$('#share-card-previews');previews.replaceChildren();cards.hidden=!reviewText;
  if(reviewText){const posterUrls=await Promise.all((script.opening?.top_four||[]).map(resolvePoster)),rendered=await makeShareCards(script,{posterUrls,format:shareFormat});for(const [name,canvas] of Object.entries(rendered)){const item=document.createElement('div');item.className='share-preview';item.append(canvas);const download=document.createElement('button');download.textContent=t('downloadCard');download.addEventListener('click',()=>downloadCard(canvas,`judge-${name}-${shareFormat}`));const share=document.createElement('button');share.textContent=t('shareCard');share.addEventListener('click',async()=>{canvas.toBlob(async blob=>{const file=new File([blob],`judge-${name}-${shareFormat}.png`,{type:'image/png'});if(navigator.canShare?.({files:[file]}))await navigator.share({files:[file],title:t('shareTitle')});else downloadCard(canvas,`judge-${name}-${shareFormat}`);},'image/png');});item.append(download,share);previews.append(item);}}
}
function home(){stop();show('landing');(upload.file?$('#judge'):$('#export')).focus();}
function ready({direct=false}={}){
  clearInterval(loadingTimer);stopLoadingPreview?.finish?.();const analyzing=$('#analyzing');analyzing.dataset.ready='true';
  $('#analyzing-title').textContent=locale==='pt-BR'?'Seu julgamento está pronto.':'Your judgment is ready.';$('#loading-copy').textContent=direct?`@${script.profile?.handle||script.profile?.name||''} · Judge #${String(script.public_result?.number||'').padStart(2,'0')}`:(locale==='pt-BR'?'O Judge terminou. Entre quando estiver pronto.':'The Judge is done. Enter when you are ready.');
  const summary=$('#ready-summary'),archetype=script.opening?.archetype_text||script.opening?.top_four_archetype?.phrase||'';summary.textContent=direct?archetype:'';summary.hidden=!direct||!archetype;
  const button=$('#start-judgment');button.textContent=direct?(locale==='pt-BR'?'VER JULGAMENTO':'VIEW JUDGMENT'):(locale==='pt-BR'?'IR PARA O JULGAMENTO':'GO TO THE JUDGMENT');button.hidden=false;
  if(direct){const host=$('#loading-films');host.replaceChildren();const track=document.createElement('div');track.className='loading-film-track settling';for(const film of script.opening?.top_four||[])track.append(filmCard(film,{showRating:false,eager:true}));host.append(track);}
  button.focus({preventScroll:true});
}
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
  stop();delete $('#analyzing').dataset.ready;$('#start-judgment').hidden=true;$('#ready-summary').hidden=true;$('#analyzing-title').textContent=t('analyzing');lastDemo=demo;const current=sequence;request=new AbortController();show('analyzing');
  const copy=t('loading').split('|');let i=0;$('#loading-copy').textContent=copy[0];if(!demo)stopLoadingPreview=startLoadingPreview(upload.file,$('#loading-films'));
  loadingTimer=setInterval(()=>{$('#loading-copy').textContent=copy[Math.min(++i,copy.length-1)];},2400);
  try{script=await(demo?loadDemo(request.signal):judgeExport(upload.file,locale,request.signal));if(current!==sequence)return;lastFailure=null;$('#local-analysis').hidden=true;try{sessionStorage.setItem('judge.presentation',JSON.stringify(script));}catch{}if(script.public_result?.slug)history.replaceState({publicResult:true},'',script.public_result.slug);ready();}
  catch(error){if(current!==sequence)return;clearInterval(loadingTimer);stopLoadingPreview?.();stopLoadingPreview=null;lastFailure=error.payload||null;$('#local-analysis').hidden=!(['aiUnavailable','analystUnavailable','writerUnavailable'].includes(error.message)&&lastFailure?.deterministic_analysis_available);const copy=t(error.message);$('#error-message').textContent=copy===error.message?t('invalid'):copy;renderTechnicalDetails(error.message,lastFailure);show('error');}
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
$('#start-judgment').addEventListener('click',()=>{stopLoadingPreview?.();stopLoadingPreview=null;delete $('#analyzing').dataset.ready;$('#start-judgment').hidden=true;play();});
$('#show-all').addEventListener('click',()=>play(true));
$('#share').addEventListener('click',async()=>{
  if(script.public_result?.slug){const url=new URL(script.public_result.slug,location.origin).href,title=t('shareTitle'),text=script.opening?.archetype_text||title;try{if(navigator.share)await navigator.share({title,text,url});else{await navigator.clipboard.writeText(url);$('#share-status').textContent=t('shared');}}catch(error){if(error.name!=='AbortError')$('#share-status').textContent=url;}return;}
  const canvases=[...document.querySelectorAll('#share-card-previews canvas')];if(!canvases.length)return;
  const files=await Promise.all(canvases.map((canvas,index)=>new Promise(resolve=>canvas.toBlob(blob=>resolve(new File([blob],`judge-${index+1}.png`,{type:'image/png'})),'image/png'))));
  try{if(navigator.canShare?.({files}))await navigator.share({title:t('shareTitle'),files});else{canvases.forEach((canvas,index)=>downloadCard(canvas,`judge-${index+1}`));$('#share-status').textContent=t('download');}}
  catch(error){if(error.name!=='AbortError'){$('#share-status').textContent=t('download');canvases.forEach((canvas,index)=>downloadCard(canvas,`judge-${index+1}`));}}
});
document.querySelectorAll('[data-share-format]').forEach(button=>button.addEventListener('click',async()=>{shareFormat=button.dataset.shareFormat;document.querySelectorAll('[data-share-format]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));await renderEnding();}));
const embedded=$('#public-result');if(embedded){try{script=validateScript(JSON.parse(embedded.textContent));if(script.locale){setLocale(script.locale);chooseLocale(script.locale);}const match=location.pathname.match(/Judge-(\d+)/i);script.public_result={slug:location.pathname,number:Number(match?.[1]||0),profile:script.profile?.handle};show('analyzing');ready({direct:true});}catch{show('error');$('#error-message').textContent=t('invalid');}}else if(new URLSearchParams(location.search).get('demo')==='1')start(true);
