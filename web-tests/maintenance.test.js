import test from 'node:test';
import assert from 'node:assert/strict';
import {onRequest} from '../functions/_middleware.js';

test('maintenance switch is off unless the Pages variable is exactly 1',async()=>{
  const response=await onRequest({request:new Request('https://example.com/'),env:{JUDGE_MAINTENANCE_MODE:'0'},next:()=>Response.json({site:'live'})});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{site:'live'});
});

test('maintenance serves a small bilingual noindex page for public routes',async()=>{
  const response=await onRequest({request:new Request('https://example.com/'),env:{JUDGE_MAINTENANCE_MODE:'1'},next:()=>assert.fail('must intercept static route')});
  const html=await response.text();assert.equal(response.status,503);assert.match(response.headers.get('content-type'),/text\/html/);assert.equal(response.headers.get('retry-after'),'900');assert.match(html,/Voltamos em breve/);assert.match(html,/undergoing a short maintenance/);assert.match(html,/noindex,nofollow/);
});

test('maintenance pauses API actions but keeps health and config diagnostics reachable',async()=>{
  const env={JUDGE_MAINTENANCE_MODE:'1'};
  const post=await onRequest({request:new Request('https://example.com/api/judge',{method:'POST'}),env,next:()=>assert.fail('must pause API action')});
  assert.equal(post.status,503);assert.deepEqual(await post.json(),{error:'maintenance',maintenance:true});
  for(const path of ['/api/judge','/api/config']){
    let called=false;const response=await onRequest({request:new Request(`https://example.com${path}`),env,next:()=>{called=true;return new Response('health')}});
    assert.equal(called,true);assert.equal(await response.text(),'health');
  }
});
