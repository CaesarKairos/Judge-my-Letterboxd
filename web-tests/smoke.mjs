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
// The ending carries the Profile Review, the explainability summary and two 4:5 share cards.
const PIXEL=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==','base64');
await page.setViewportSize({width:1366,height:768});
await page.unroute('**/api/poster?*');
await page.route('**/api/poster?*',route=>route.fulfill({json:{resolved:true,poster_url:'https://image.tmdb.org/t/p/w342/fixture.png'}}));
await page.route('**/image.tmdb.org/**',route=>route.fulfill({contentType:'image/png',body:PIXEL}));
await page.route('**/api/image-proxy?*',route=>route.fulfill({contentType:'image/png',body:PIXEL}));
await page.evaluate(()=>localStorage.clear());
await page.emulateMedia({reducedMotion:'reduce'});await page.goto(base+'/?demo=1');await page.locator('#ending').waitFor();
assert.equal(await page.locator('.profile-review-card h3').isVisible(),true);
assert.ok((await page.locator('.profile-review-card p').textContent()).trim().length>80);
assert.ok((await page.locator('#profile-review .eyebrow').textContent()).trim().length>0);
assert.equal(await page.locator('#share-card-previews canvas').count(),2);
assert.equal(await page.locator('#card-avatar').count(),0);
assert.equal(await page.locator('.avatar-picker').count(),0);
assert.deepEqual(await page.locator('#share-card-previews canvas').evaluateAll(nodes=>nodes.map(node=>[node.width,node.height])),[[1080,1350],[1080,1350]]);
await page.locator('[data-share-format="story"]').click();
await page.waitForFunction(()=>[...document.querySelectorAll('#share-card-previews canvas')].every(node=>node.height===1920));
assert.deepEqual(await page.locator('#share-card-previews canvas').evaluateAll(nodes=>nodes.map(node=>[node.width,node.height])),[[1080,1920],[1080,1920]]);
await page.locator('[data-share-format="post"]').click();
await page.waitForFunction(()=>[...document.querySelectorAll('#share-card-previews canvas')].every(node=>node.height===1350));
// A tainted canvas would throw here, so the proxy is exercised, not assumed.
const blobs=await page.locator('#share-card-previews canvas').evaluateAll(nodes=>Promise.all(nodes.map(node=>new Promise(resolve=>node.toBlob(blob=>resolve(blob?blob.size:0),'image/png')))));
assert.ok(blobs.every(size=>size>8000),`png cards: ${blobs.join(',')}`);
assert.equal(await page.locator('#explainability').isVisible(),true);
const explain=(await page.locator('#explainability-copy').textContent()).trim();
assert.ok(explain.length>120,'the explainability copy must describe this account');
assert.ok(explain.includes('arquivos'));
const download=page.waitForEvent('download');
await page.locator('.share-preview button').first().click();
assert.match((await download).suggestedFilename(),/\.png$/);
await page.locator('#share-cards').screenshot({path:'web-tests/artifacts/share-cards.png'});

await page.goto(base+'/web-tests/harness.html');await page.locator('#done').filter({hasText:'PASS'}).waitFor();
for(const type of ['message','strike','correction','profile_stats','film','film_pair','film_group','review_quote','tag','tag_list_relationship','list','rating','rewatch','phrase','stat'])assert.ok(await page.locator(`[data-event="${type}"]`).count()>0,type);
assert.equal(await page.locator('.review img').count(),0);assert.ok(await page.locator('.review strong').count());
// Quoted reviews are rendered as real blockquotes, never as literal markup.
assert.ok(await page.locator('.judge-quote').count()>0);assert.ok(await page.locator('.review blockquote').count()>0);
assert.equal((await page.locator('#chat').textContent()).includes('<blockquote'),false);
// A list member and a tag card show the film's current rating: those rows carry no rating column,
// so a rated film must never be printed as "Sem nota" there.
const listRatings=await page.locator('.attachment-list .film-card .rating').allTextContents();
const tagRatings=await page.locator('.attachment-tag .film-card .rating').allTextContents();
assert.ok(listRatings.some(text=>text.includes('★ 5 / 5')),`list ratings: ${listRatings.join(' | ')}`);
assert.ok(tagRatings.some(text=>text.includes('★ 5 / 5')),`tag ratings: ${tagRatings.join(' | ')}`);
const relation=page.locator('[data-event="tag_list_relationship"]').first();
assert.equal(await relation.locator('.relationship-entity').count(),2);
assert.match(await relation.textContent(),/Tag A/);assert.match(await relation.textContent(),/List A/);
assert.ok(listRatings.some(text=>!text.includes('★')),`an unrated member stays unrated: ${listRatings.join(' | ')}`);
// The site icon is the camera-reels mark, from one file: the tab, the brand and the chip of the
// chosen export. The brand icon must actually load, so a missing asset cannot pass silently.
await page.goto(base);
assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'),'/images/camera-reels-fill.svg');
assert.equal(await page.locator('.brand img').getAttribute('src'),'/images/camera-reels-fill.svg');
assert.equal(await page.locator('#selected .file-icon').getAttribute('src'),'/images/camera-reels-fill.svg');
await page.waitForFunction(()=>document.querySelector('.brand img')?.complete===true);
assert.ok(await page.locator('.brand img').evaluate(node=>node.naturalWidth>0),'o ícone da marca precisa carregar');
// A resolved poster replaces the abstract card, and a refused lookup keeps it.
await page.unroute('**/api/poster?*');
await page.route('**/api/poster?*',route=>route.fulfill({json:{resolved:true,poster_url:'https://image.tmdb.org/t/p/w342/fixture.png'}}));
await page.route('**/image.tmdb.org/**',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==','base64')}));
await page.goto(base+'/web-tests/harness.html');await page.locator('#done').filter({hasText:'PASS'}).waitFor();
const posterCard=page.locator('.film-card .poster').first();await posterCard.locator('.poster-image').waitFor();
assert.equal(await posterCard.locator('.poster-fallback').first().isHidden(),true);
assert.equal(await page.locator('.film-card .poster-image').count()>0,true);
await page.evaluate(()=>localStorage.clear());
await page.unroute('**/api/poster?*');
await page.route('**/api/poster?*',route=>route.fulfill({json:{resolved:false,reason:'no_match'}}));
await page.goto(base+'/web-tests/harness.html');await page.locator('#done').filter({hasText:'PASS'}).waitFor();await page.waitForTimeout(400);
assert.equal(await page.locator('.film-card .poster-image').count(),0);
assert.equal(await page.locator('.film-card .poster .poster-fallback').first().isVisible(),true);
// The abstract card carries the site icon, loaded from the same file as the tab.
await page.waitForFunction(()=>document.querySelector('.poster-fallback .film-symbol')?.complete===true);
assert.ok(await page.locator('.poster-fallback .film-symbol').first().evaluate(node=>node.naturalWidth>0),'o ícone do cartaz abstrato precisa carregar');
await page.evaluate(()=>localStorage.clear());
await page.unroute('**/api/poster?*');
await page.route('**/api/poster?*',route=>route.fulfill({json:{resolved:false}}));

await page.goto(base);await page.locator('#export').setInputFiles({name:'bad.txt',mimeType:'text/plain',buffer:Buffer.from('x')});await page.locator('#upload-error').filter({hasText:'ZIP'}).waitFor();
await page.route('**/api/judge',route=>route.fulfill({status:501,json:{error:'not_connected'}}));
await page.locator('#export').setInputFiles({name:'export.zip',mimeType:'application/zip',buffer:Buffer.from([80,75,3,4,0,0])});
await page.locator('#selected').waitFor();await page.locator('#judge').click();await page.locator('#error').waitFor();assert.match(await page.locator('#error-message').textContent(),/não está disponível/);await page.emulateMedia({reducedMotion:'no-preference'});
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
await page.mouse.move(600,400);await page.mouse.wheel(0,-500);
// The ending grows while the queue finishes, so a late resize may hide the shortcut once more;
// scrolling up again is exactly what the visitor would do.
try{await page.locator('#bottom').waitFor({state:'visible',timeout:4000});}
catch{await page.mouse.wheel(0,-300);await page.locator('#bottom').waitFor({state:'visible',timeout:4000});}
await page.locator('#bottom').click();await page.waitForTimeout(200);
assert.deepEqual(errors,[]);await browser.close();
for(const engine of (process.env.ALL_BROWSERS==='1'?[firefox,webkit]:[])){
 const b=await engine.launch();const p=await b.newPage({reducedMotion:'reduce'});await p.route('**/api/poster?*',r=>r.fulfill({json:{resolved:false}}));await p.goto(base+'/?demo=1');await p.locator('#ending').waitFor();assert.equal(await p.locator('.top-four .film-card').count(),4);await b.close();
}
console.log('PASS: five viewports, real demo, every event, XSS text, real blockquotes, upload, API boundary, custom language menu, AI pacing, Top 4, scroll, reduced motion; Chromium'+(process.env.ALL_BROWSERS==='1'?'/Firefox/WebKit':'')+'.');

