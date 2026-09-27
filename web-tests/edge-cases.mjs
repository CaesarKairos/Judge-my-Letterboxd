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
await page.goto(base);
await page.evaluate(()=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([80,75,3,4])],'dropped.zip',{type:'application/zip'}));document.querySelector('#dropzone').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));});
await page.locator('#selected').waitFor();assert.equal(await page.locator('#file-name').textContent(),'dropped.zip');await page.locator('#remove').click();assert.equal(await page.locator('#judge').isDisabled(),true);
await page.locator('#export').setInputFiles({name:'zip.zip',mimeType:'application/zip',buffer:Buffer.from([80,75,3,4])});
for(const [status,text] of [[429,'Muitos julgamentos'],[500,'problema'],[200,'roteiro válido']]){
 await page.route('**/api/judge',r=>r.fulfill({status,body:status===200?'<html>invalid</html>':''}));
 await page.locator('#judge').click();await page.locator('#error').waitFor();assert.ok((await page.locator('#error-message').textContent()).includes(text));await page.locator('#error-back').click();await page.unroute('**/api/judge');
}
await page.route('**/api/judge',async r=>{await new Promise(resolve=>setTimeout(resolve,300));await r.fulfill({status:501,body:''}).catch(()=>{});});
await page.locator('#judge').click();await page.locator('#cancel').click();await page.waitForTimeout(500);assert.equal(await page.locator('#landing').isVisible(),true);
await page.goto(base+'/?demo=1');await page.locator('#ending').waitFor();await page.locator('.favorites').scrollIntoViewIfNeeded();await page.screenshot({path:'web-tests/artifacts/top-four-mobile.png'});
await browser.close();console.log('PASS: zero/one/two/four favorites, oversized ZIP, safe DOM, drag/drop/remove, 429/500/invalid response, cancellation, mobile favorites.');
