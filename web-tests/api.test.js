import {test} from 'node:test';
import assert from 'node:assert/strict';
import {judgeExport} from '../js/api.js';
import {onRequestGet} from '../functions/api/poster.js';
test('adapter submits only on call, correct multipart fields and locale',async t=>{
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(url,'/api/judge');assert.equal(options.method,'POST');assert.equal(options.body.get('locale'),'pt-BR');assert.equal(options.body.get('export').name,'test.zip');
  return Response.json({version:'presentation-v1',events:[{type:'pause',duration:'short'}]});
 });
 assert.equal((await judgeExport(new File(['PK'],'test.zip'),'pt-BR')).version,'presentation-v1');
});
test('API errors, malformed JSON and incompatible contracts have distinct states',async t=>{
 const file=new File(['PK'],'test.zip');
 for(const [status,error] of [[404,'unavailable'],[501,'unavailable'],[429,'rate'],[500,'server'],[413,'large']]){
  const mock=t.mock.method(globalThis,'fetch',async()=>new Response('',{status}));await assert.rejects(judgeExport(file,'en-US'),new RegExp(error));mock.mock.restore();
 }
 let mock=t.mock.method(globalThis,'fetch',async()=>new Response('<html>'));await assert.rejects(judgeExport(file,'en-US'),/invalid/);mock.mock.restore();
 mock=t.mock.method(globalThis,'fetch',async()=>Response.json({version:'v2'}));await assert.rejects(judgeExport(file,'en-US'),/incompatible/);mock.mock.restore();
 mock=t.mock.method(globalThis,'fetch',async()=>{throw new TypeError('fetch failed');});await assert.rejects(judgeExport(file,'en-US'),/offline/);mock.mock.restore();
});
test('poster proxy returns minimal metadata and tolerates provider failure',async t=>{
 let mock=t.mock.method(globalThis,'fetch',async()=>Response.json({results:[{id:4,title:'Movie',release_date:'2000-01-01',poster_path:'/abc.jpg'}]}));
 const context={request:new Request('https://example.com/api/poster?title=Movie&year=2000'),env:{TMDB_API_KEY:'test-only'}};
 const result=await onRequestGet(context);assert.deepEqual(await result.json(),{poster_url:'https://image.tmdb.org/t/p/w342/abc.jpg',tmdb_id:4,resolved:true});assert.match(result.headers.get('Cache-Control'),/604800/);mock.mock.restore();
 mock=t.mock.method(globalThis,'fetch',async()=>{throw new Error('provider down');});assert.equal((await (await onRequestGet(context)).json()).resolved,false);
});
