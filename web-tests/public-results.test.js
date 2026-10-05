import {test} from 'node:test';
import assert from 'node:assert/strict';
import {savePublicResult,getPublicResult} from '../functions/_lib/public-results.js';
import {onRequest,ogImage} from '../functions/[[path]].js';

class MemoryD1{
 constructor(){this.rows=[];}
 prepare(sql){return {bind:(...args)=>({first:async()=>sql.startsWith('SELECT COALESCE')?{number:Math.max(0,...this.rows.filter(row=>row.profile_key===args[0]).map(row=>row.judge_number))+1}:this.rows.find(row=>row.profile_key===args[0]&&row.judge_number===args[1])||null,run:async()=>{await new Promise(resolve=>setTimeout(resolve,1));if(this.rows.some(row=>row.profile_key===args[0]&&row.judge_number===args[2]))throw new Error('UNIQUE constraint');const [profile_key,profile_display,judge_number,slug,locale,description,presentation_json,created_at]=args;this.rows.push({profile_key,profile_display,judge_number,slug,locale,description,presentation_json,created_at});return {success:true};}})};}
}
const presentation=(title='First')=>({version:'presentation-v2',locale:'pt-BR',profile:{handle:'critic'},opening:{top_four:[{title,year:'2020'}],archetype_text:'curador do caos'},profile_review:{text:'Texto público',evidence_refs:['secret-ref']},events:[{type:'message',segments:[{text:title}]}],ai:{prompt:'never'},explainability:{archive:'never'}});

test('D1 unique key allocates concurrent Judge numbers and stores sanitized Presentations',async()=>{
 const db=new MemoryD1(),env={RESULTS_DB:db};const [first,second]=await Promise.all([savePublicResult(env,presentation('One')),savePublicResult(env,presentation('Two'))]);assert.deepEqual(new Set([first.number,second.number]),new Set([1,2]));assert.equal(db.rows.length,2);assert.ok(db.rows.every(row=>!row.presentation_json.includes('prompt')&&!row.presentation_json.includes('archive')));assert.notEqual((await getPublicResult(db,'critic',1)).presentation_json,(await getPublicResult(db,'critic',2)).presentation_json);
});

test('direct result HTML has server metadata and its durable OG is 1200x630',async()=>{
 const db=new MemoryD1(),saved=await savePublicResult({RESULTS_DB:db},presentation()),png=new Uint8Array(24);png.set([137,80,78,71]);new DataView(png.buffer).setUint32(16,1200);new DataView(png.buffer).setUint32(20,630);const env={RESULTS_DB:db,ASSETS:{fetch:async()=>new Response('<!doctype html><html lang="pt-BR"><head><title>base</title></head><body><main></main></body></html>')},__TEST_OG_RENDERER:async element=>{const serialized=JSON.stringify(element);assert.match(serialized,/@critic/);assert.match(serialized,/First/);return new Response(png,{headers:{'Content-Type':'image/png'}});}};
 const response=await onRequest({request:new Request(`https://example.test${saved.slug}`),env}),html=await response.text();assert.equal(response.status,200);for(const token of ['canonical','og:title','og:description','og:image','og:url','twitter:card','@critic foi julgado'])assert.match(html,new RegExp(token));
 const og=await onRequest({request:new Request(`https://example.test${saved.slug}/og.png`),env}),image=new Uint8Array(await og.arrayBuffer());assert.equal(og.status,200);assert.match(og.headers.get('content-type'),/^image\/png/);assert.deepEqual([...image.slice(1,4)],[80,78,71]);assert.equal(new DataView(image.buffer,image.byteOffset,image.byteLength).getUint32(16),1200);assert.equal(new DataView(image.buffer,image.byteOffset,image.byteLength).getUint32(20),630);
 const missing=await onRequest({request:new Request('https://example.test/@critic/Judge-99'),env});assert.equal(missing.status,404);
});
