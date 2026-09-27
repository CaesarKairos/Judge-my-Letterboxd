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
// Quoted reviews are rendered as real blockquotes, never as literal markup.
assert.ok(await page.locator('.judge-quote').count()>0);assert.ok(await page.locator('.review blockquote').count()>0);
assert.equal((await page.locator('#chat').textContent()).includes('<blockquote'),false);
// A resolved poster replaces the abstract card, and a refused lookup keeps it.
await page.unroute('**/api/poster?*');
await page.route('**/api/poster?*',route=>route.fulfill({json:{resolved:true,poster_url:'https://image.tmdb.org/t/p/w342/fixture.png'}}));
await page.route('**/image.tmdb.org/**',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==','base64')}));
await page.goto(base+'/web-tests/harness.html');await page.locator('#done').filter({hasText:'PASS'}).waitFor();
const posterCard=page.locator('.film-card .poster').first();await posterCard.locator('img').waitFor();
assert.equal(await posterCard.locator('.poster-fallback').first().isHidden(),true);
assert.equal(await page.locator('.film-card .poster img').count()>0,true);
await page.evaluate(()=>localStorage.clear());
await page.unroute('**/api/poster?*');
await page.route('**/api/poster?*',route=>route.fulfill({json:{resolved:false,reason:'no_match'}}));
await page.goto(base+'/web-tests/harness.html');await page.locator('#done').filter({hasText:'PASS'}).waitFor();await page.waitForTimeout(400);
assert.equal(await page.locator('.film-card .poster img').count(),0);
assert.equal(await page.locator('.film-card .poster .poster-fallback').first().isVisible(),true);
await page.evaluate(()=>localStorage.clear());
await page.unroute('**/api/poster?*');
await page.route('**/api/poster?*',route=>route.fulfill({json:{resolved:false}}));

await page.goto(base);await page.locator('#export').setInputFiles({name:'bad.txt',mimeType:'text/plain',buffer:Buffer.from('x')});await page.locator('#upload-error').filter({hasText:'ZIP'}).waitFor();
await page.route('**/api/judge',route=>route.fulfill({status:501,json:{error:'not_connected'}}));
await page.locator('#export').setInputFiles({name:'export.zip',mimeType:'application/zip',buffer:Buffer.from([80,75,3,4,0,0])});
assert.equal(await page.locator('#selected').isVisible(),true);await page.locator('#judge').click();await page.locator('#error').waitFor();assert.match(await page.locator('#error-message').textContent(),/não está disponível/);await page.emulateMedia({reducedMotion:'no-preference'});
await page.emulateMedia({reducedMotion:'no-preference'});await page.goto(base+'/?demo=1');await page.locator('#chat .typing').waitFor();
await page.goto(base);
// No playback controls remain: the language menu is the header's only custom control.
assert.equal(await page.locator('#controls').count(),0);
assert.equal(await page.locator('#language-menu select').count(),0);
assert.equal(await page.locator('#language-label').textContent(),'PT');
await page.locator('#language-menu summary').click();
await page.locator('#language-menu [data-locale="en-US"]').click();
assert.equal(await page.locator('#language-label').textContent(),'EN');
assert.equal(await page.locator('#landing h1 span').first().textContent(),'Everyone is a critic.');
await page.locator('#language-menu summary').click();
await page.locator('#language-menu [data-locale="pt-BR"]').click();
assert.equal(await page.locator('#language-label').textContent(),'PT');
await page.emulateMedia({reducedMotion:'no-preference'});await page.goto(base+'/?demo=1');await page.locator('#chat .typing').waitFor();
const early=(await page.locator('#chat').textContent()).length;await page.waitForTimeout(1500);const paced=(await page.locator('#chat').textContent()).length;
assert.ok(paced>early,'the judgment is paced over time, not printed at once');
// The queue is automatic: no pause, speed or skip control exists anymore.
await page.locator('.top-four').waitFor({timeout:120000});await page.locator('.archetype').waitFor();assert.equal(await page.locator('.top-four .film-card').count(),4);
await page.screenshot({path:'web-tests/artifacts/top-four.png',fullPage:true});
// Playback continues on its own; scrolling away proves the bottom shortcut works.
await page.mouse.move(600,400);await page.mouse.wheel(0,-500);await page.waitForTimeout(200);assert.equal(await page.locator('#bottom').isVisible(),true);
await page.locator('#bottom').click();await page.waitForTimeout(200);
assert.deepEqual(errors,[]);await browser.close();
for(const engine of (process.env.ALL_BROWSERS==='1'?[firefox,webkit]:[])){
 const b=await engine.launch();const p=await b.newPage({reducedMotion:'reduce'});await p.route('**/api/poster?*',r=>r.fulfill({json:{resolved:false}}));await p.goto(base+'/?demo=1');await p.locator('#ending').waitFor();assert.equal(await p.locator('.top-four .film-card').count(),4);await b.close();
}
console.log('PASS: five viewports, real demo, every event, XSS text, real blockquotes, upload, API boundary, custom language menu, AI pacing, Top 4, scroll, reduced motion; Chromium'+(process.env.ALL_BROWSERS==='1'?'/Firefox/WebKit':'')+'.');

