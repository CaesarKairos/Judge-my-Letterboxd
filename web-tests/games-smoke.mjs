import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const base=process.env.WEB_BASE_URL||'http://127.0.0.1:8080',browser=await chromium.launch(),page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
await page.route('**/api/poster?*',route=>route.fulfill({json:{resolved:false}}));

await page.goto(base+'/web-tests/games.html?game=forced');await page.locator('.game-card').waitFor();assert.equal((await page.locator('.game-card').textContent()).includes('★'),false);const selects=page.locator('.game-select');await selects.nth(0).selectOption('keep');await selects.nth(1).selectOption('defend');await selects.nth(2).selectOption('retire');await page.locator('.game-confirm').click();await page.locator('#done').filter({hasText:'PASS'}).waitFor();assert.match(await page.locator('.game-result').textContent(),/forced específica/);assert.match(await page.locator('#chat').textContent(),/TIMELINE_CONTINUED/);

await page.goto(base+'/web-tests/games.html?game=blind');await page.locator('.game-card').waitFor();assert.equal(await page.locator('.game-card .film-card').count(),1);assert.equal((await page.locator('.game-card').textContent()).includes('★'),false);for(const rank of ['1','2','3']){await page.locator('.game-select').selectOption(rank);await page.locator('.game-confirm').click();}await page.locator('#done').filter({hasText:'PASS'}).waitFor();assert.match(await page.locator('.game-result').textContent(),/Match histórico/);

await page.goto(base+'/web-tests/games.html?game=defend');await page.locator('.game-card').waitFor();await page.locator('.game-choice').first().focus();assert.equal(await page.locator('.game-choice').first().evaluate(node=>node===document.activeElement),true);await page.keyboard.press('Enter');await page.locator('#done').filter({hasText:'PASS'}).waitFor();assert.match(await page.locator('#chat').textContent(),/TIMELINE_CONTINUED/);

await page.goto(base+'/web-tests/games.html?game=forced');await page.locator('.game-skip').click();await page.locator('#done').filter({hasText:'PASS'}).waitFor();assert.match(await page.locator('.game-result').textContent(),/pulado/);assert.match(await page.locator('#chat').textContent(),/TIMELINE_CONTINUED/);
await browser.close();console.log('PASS: forced triage, blind rank, defend take, keyboard, hidden ratings, skip and timeline resume.');
