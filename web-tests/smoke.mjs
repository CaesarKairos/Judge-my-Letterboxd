import {chromium,firefox,webkit} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const base=process.env.WEB_BASE_URL||'http://127.0.0.1:8080';
await mkdir('web-tests/artifacts',{recursive:true});
const browser=await chromium.launch();const page=await browser.newPage({locale:'pt-BR'});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/poster?*',route=>route.fulfill({json:{resolved:false}}));
for(const [width,height] of [[360,800],[390,844],[768,1024],[1366,768],[1920,1080]]){
 await page.setViewportSize({width,height});await page.goto(base);
 assert.equal(await page.locator('#landing').isVisible(),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:`web-tests/artifacts/landing-${width}.png`,fullPage:true});
 await page.emulateMedia({reducedMotion:'reduce'});await page.goto(base+'/?demo=1');await page.locator('#ending').waitFor();
 assert.equal(await page.locator('.top-four .film-card').count(),4);
 assert.equal(await page.locator('.attachment-film_pair .film-card').count(),2);
 assert.ok(await page.locator('.review').count()>0);assert.equal(await page.locator('.rewatch-timeline li').count(),3);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:`web-tests/artifacts/demo-${width}.png`,fullPage:true});
}
await page.goto(base+'/web-tests/harness.html');await page.locator('#done').filter({hasText:'PASS'}).waitFor();
for(const type of ['message','strike','correction','profile_stats','film','film_pair','film_group','review_quote','tag','list','rating','rewatch','phrase','stat'])assert.ok(await page.locator(`[data-event="${type}"]`).count()>0,type);
assert.equal(await page.locator('.review img').count(),0);assert.ok(await page.locator('.review strong').count());
await page.goto(base);await page.locator('#export').setInputFiles({name:'bad.txt',mimeType:'text/plain',buffer:Buffer.from('x')});await page.locator('#upload-error').filter({hasText:'ZIP'}).waitFor();
await page.route('**/api/judge',route=>route.fulfill({status:501,json:{error:'not_connected'}}));
await page.locator('#export').setInputFiles({name:'export.zip',mimeType:'application/zip',buffer:Buffer.from([80,75,3,4,0,0])});
assert.equal(await page.locator('#selected').isVisible(),true);await page.locator('#judge').click();await page.locator('#error').waitFor();assert.match(await page.locator('#error-message').textContent(),/backend web/);
await page.emulateMedia({reducedMotion:'no-preference'});await page.goto(base+'/?demo=1');await page.locator('#chat .typing').waitFor();
await page.locator('#controls summary').click();await page.locator('#pause').click();const before=await page.locator('#chat').textContent();await page.waitForTimeout(300);assert.equal(await page.locator('#chat').textContent(),before);
await page.locator('#speed').click();assert.equal(await page.locator('#speed').textContent(),'1.5×');await page.locator('#pause').click();
await page.locator('.top-four').waitFor({timeout:20000});await page.locator('.archetype').waitFor();assert.equal(await page.locator('.top-four .film-card').count(),4);
await page.screenshot({path:'web-tests/artifacts/top-four.png',fullPage:true});
await page.locator('#skip').click();await page.locator('#ending').waitFor();
await page.evaluate(()=>window.scrollTo(0,200));await page.waitForTimeout(150);assert.equal(await page.locator('#bottom').isVisible(),true);
await page.locator('#bottom').click();await page.waitForTimeout(200);
assert.deepEqual(errors,[]);await browser.close();
for(const engine of (process.env.ALL_BROWSERS==='1'?[firefox,webkit]:[])){
 const b=await engine.launch();const p=await b.newPage({reducedMotion:'reduce'});await p.route('**/api/poster?*',r=>r.fulfill({json:{resolved:false}}));await p.goto(base+'/?demo=1');await p.locator('#ending').waitFor();assert.equal(await p.locator('.top-four .film-card').count(),4);await b.close();
}
console.log('PASS: five viewports, real demo, every event, XSS text, upload, API boundary, pause/speed/skip, Top 4, scroll, reduced motion; Chromium'+(process.env.ALL_BROWSERS==='1'?'/Firefox/WebKit':'')+'.');

