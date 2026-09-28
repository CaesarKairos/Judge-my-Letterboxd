import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:390,height:844},locale:'pt-BR',reducedMotion:'reduce'});
const base=process.env.WEB_BASE_URL||'http://127.0.0.1:8080';
await page.route('**/api/poster?*',r=>r.fulfill({json:{resolved:false}}));
await page.goto(base+'/web-tests/harness.html');await page.locator('#done').filter({hasText:'PASS'}).waitFor();
const results=await page.evaluate(async()=>{
 const {ChatPlayer}=await import('/js/chat-renderer.js');
 const {filmCard}=await import('/js/poster-service.js');
 const {validateFile,MAX_FILE_SIZE}=await import('/js/upload.js');
 const root=document.querySelector('#chat'),counts=[];
 for(const count of [0,1,2,4]){
  root.replaceChildren();const player=new ChatPlayer(root,document.querySelector('#bottom'),document.querySelector('#announce'));player.clock.skip();
  await player.play({opening:{top_four:Array.from({length:count},()=>({title:'Fixture',year:'2000'}))},events:[{type:'message',cue:'top_four_reveal',segments:[{text:'Intro'}]},{type:'message',role:'archetype_phrase',segments:[{text:'Nickname'}]}]});
  counts.push(root.querySelectorAll('.top-four .film-card').length);player.stop();
 }
 let large=false;try{await validateFile({name:'big.zip',size:MAX_FILE_SIZE+1});}catch(e){large=e.message==='large';}
 const safe=filmCard({title:'<script>bad</script>',poster_url:'javascript:alert(1)'});root.append(safe);
 return {counts,large,safe:!root.querySelector('script')};
});
assert.deepEqual(results,{counts:[0,1,2,4],large:true,safe:true});
// Interactive challenges pause without leaking historical ratings. A skip resumes cleanly.
await page.goto(base+'/web-tests/harness.html');await page.locator('#done').filter({hasText:'PASS'}).waitFor();
await page.evaluate(async()=>{
 const {createInteractiveGame,renderGameResult}=await import('/js/game-renderer.js');
 const root=document.querySelector('#chat');root.replaceChildren();
 const event={type:'game_blind_rank',game_id:'blind-fixture',game_type:'blind_rank',skip_label:'Pular',instructions:'Ranqueie sem notas',films:[
  {film_key:'a',title:'Film A',year:'2000'},{film_key:'b',title:'Film B',year:'2001'},{film_key:'c',title:'Film C',year:'2002'}]};
 const game=createInteractiveGame(event);root.append(game.node);
 window.__blindDone=game.done.then(result=>{root.append(renderGameResult({type:'game_result',game_id:'blind-fixture',game_type:'blind_rank',history:[
  {film_key:'a',title:'Film A',year:'2000',rating:5,rewatches:1},{film_key:'b',title:'Film B',year:'2001',rating:4.5,rewatches:0},{film_key:'c',title:'Film C',year:'2002',rating:5,rewatches:2}],result_reactions:{match:'bateu'}},result));return result;});
});
assert.equal(await page.locator('#chat .rating').count(),0);
await page.locator('.rank-button').filter({hasText:'1º'}).click();
await page.locator('.rank-button').filter({hasText:'2º'}).click();
await page.locator('.rank-button').filter({hasText:'3º'}).click();
await page.evaluate(()=>window.__blindDone);
assert.ok(await page.locator('.game-result .rating').count()>=3);

await page.evaluate(async()=>{
 const {createInteractiveGame}=await import('/js/game-renderer.js');const root=document.querySelector('#chat');root.replaceChildren();
 const event={type:'game_forced_triage',game_id:'skip-fixture',game_type:'forced_triage',skip_label:'Pular',confirm_label:'Confirmar',roles:[{id:'r3',rank:3,label:'Guarda'},{id:'r2',rank:2,label:'Empresta'},{id:'r1',rank:1,label:'Solta'}],films:[
  {film_key:'a',title:'Film A',year:'2000'},{film_key:'b',title:'Film B',year:'2001'},{film_key:'c',title:'Film C',year:'2002'}]};
 const game=createInteractiveGame(event);root.append(game.node);window.__skipDone=game.done;
});
await page.locator('.game-skip').click();const skipped=await page.evaluate(()=>window.__skipDone);assert.equal(skipped.skipped,true);

await page.goto(base);
await page.evaluate(()=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([80,75,3,4])],'dropped.zip',{type:'application/zip'}));document.querySelector('#dropzone').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));});
await page.locator('#selected').waitFor();assert.equal(await page.locator('#file-name').textContent(),'dropped.zip');await page.locator('#remove').click();assert.equal(await page.locator('#judge').isDisabled(),true);
await page.locator('#export').setInputFiles({name:'zip.zip',mimeType:'application/zip',buffer:Buffer.from([80,75,3,4])});
// Each status is asserted against the copy the interface actually shows today.
for(const [status,body,text] of [[429,'','Muitos julgamentos'],[500,'','interrompida'],[200,'<html>invalid</html>','perdeu nos bastidores']]){
 await page.route('**/api/judge',r=>r.fulfill({status,body}));
 await page.locator('#judge').click();await page.locator('#error').waitFor();assert.ok((await page.locator('#error-message').textContent()).includes(text));await page.locator('#error-back').click();await page.unroute('**/api/judge');
}
// AI_FAILED: the API reports that the model produced nothing usable, so the chat must not start
// by itself. The deterministic analysis exists, but only as an explicit choice of the visitor.
await page.route('**/api/judge',r=>r.fulfill({status:503,json:{error:'ai_unavailable',retryable:true,deterministic_analysis_available:true,analysis:{stats:[{key:'watched_films',label:'filmes vistos',value:106},{key:'reviews',label:'reviews',value:103}],overview:{}}}}));
await page.locator('#judge').click();await page.locator('#error').waitFor();
assert.match(await page.locator('#error-message').textContent(),/sem palavras/);
assert.equal(await page.locator('#judgment').isVisible(),false);
assert.equal(await page.locator('#local-analysis').isVisible(),true);
await page.locator('#local-analysis').click();await page.locator('#judgment').waitFor();
assert.ok(await page.locator('#chat .stats').count()>0);
assert.equal(await page.locator('#chat .film-card').count(),0);
await page.locator('#ending').waitFor();await page.locator('#another').click();
await page.unroute('**/api/judge');

await page.route('**/api/judge',async r=>{await new Promise(resolve=>setTimeout(resolve,300));await r.fulfill({status:501,body:''}).catch(()=>{});});
await page.locator('#judge').click();await page.locator('#cancel').click();await page.waitForTimeout(500);assert.equal(await page.locator('#landing').isVisible(),true);
await page.goto(base+'/?demo=1');await page.locator('#ending').waitFor();await page.locator('.favorites').scrollIntoViewIfNeeded();await page.screenshot({path:'web-tests/artifacts/top-four-mobile.png'});
await browser.close();console.log('PASS: zero/one/two/four favorites, oversized ZIP, safe DOM, drag/drop/remove, 429/500/invalid response, AI_FAILED never plays alone, local analysis by choice, cancellation, mobile favorites.');
