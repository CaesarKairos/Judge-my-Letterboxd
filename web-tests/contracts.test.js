import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {validateScript} from '../js/utils.js';
import {matchMovie,onRequestGet as getPoster} from '../functions/api/poster.js';
import {onRequestGet as getJudge} from '../functions/api/judge.js';
test('real fixture preserves all original narrative and evidence',()=>{
 const demo=JSON.parse(readFileSync('data/demo-presentation.json','utf8'));validateScript(demo);
 if(existsSync('output/presentation_script.json')){
  const original=JSON.parse(readFileSync('output/presentation_script.json','utf8'));
  assert.deepEqual(demo.events.map(({cue,role,...e})=>e),original.events.map(({cue,role,...e})=>e));
 }
 assert.equal(demo.opening.top_four.length,4);assert.equal(demo.events[3].cue,'top_four_reveal');assert.equal(demo.events[4].role,'archetype_phrase');
});
test('invalid versions and shapes rejected, future events allowed',()=>{
 assert.throws(()=>validateScript({version:'v2',events:[]}));assert.throws(()=>validateScript({version:'presentation-v1',events:[{type:'message',segments:null}]}));
 assert.doesNotThrow(()=>validateScript({version:'presentation-v1',events:[{type:'future'}]}));
});
test('poster matching prefers the exact year, forgives one year and breaks ties by popularity',()=>{
 const movie={id:1,title:'A Movie',release_date:'2000-01-01',popularity:5,poster_path:'/a.jpg'};
 assert.equal(matchMovie([movie],'A Movie','2000'),movie);
 assert.equal(matchMovie([movie],'Another Movie','2000'),null);
 assert.equal(matchMovie([movie],'A Movie','2001'),movie);
 assert.equal(matchMovie([movie],'A Movie','2010'),null);
 assert.equal(matchMovie([{...movie,poster_path:null}],'A Movie','2000'),null);
 assert.equal(matchMovie([{...movie,title:'Filme A',original_title:'Filme A'}],'Filme A','2000').id,1);
 // Duplicated entries for the same film are common: the popular one wins instead of nothing.
 assert.equal(matchMovie([movie,{...movie,id:2,popularity:50}],'A Movie','2000').id,2);
 const remake={...movie,id:3,release_date:'2015-01-01',popularity:80};
 assert.equal(matchMovie([movie,remake],'A Movie','2015').id,3);
 assert.equal(matchMovie([movie,remake],'A Movie','2000').id,1);
});
test('poster lookups drop the year filter and retry in the viewer language',async t=>{
 const seen=[];
 t.mock.method(globalThis,'fetch',async url=>{
  const params=new URL(String(url)).searchParams;seen.push(params);
  if(params.get('primary_release_year')==='2025'||params.get('language'))return Response.json({results:[]});
  return Response.json({results:[{id:7,title:'Young Hearts',original_title:'Young Hearts',release_date:'2024-05-03',poster_path:'/young.jpg',popularity:12}]});
 });
 const result=await getPoster({request:new Request('https://example.com/api/poster?title=Young%20Hearts&year=2025&locale=pt-BR'),env:{TMDB_API_KEY:'key'}});
 const body=await result.json();
 assert.equal(body.resolved,true);assert.equal(body.poster_url,'https://image.tmdb.org/t/p/w342/young.jpg');assert.equal(body.tmdb_id,7);
 // Year filter, then the viewer language, then no year at all: three looks, best match kept.
 assert.deepEqual(seen.map(params=>[params.get('primary_release_year'),params.get('language')]),[['2025',null],['2025','pt-BR'],[null,null]]);
 assert.equal(seen.every(params=>params.get('include_adult')==='false'),true);
});
test('a poster that cannot be matched says why it fell back',async t=>{
 let behaviour=()=>Response.json({results:[{id:1,title:'Another Movie',original_title:'Another Movie',release_date:'2000-01-01',poster_path:'/x.jpg'}]});
 t.mock.method(globalThis,'fetch',async()=>behaviour());
 const lookup=async env=>await (await getPoster({request:new Request('https://example.com/api/poster?title=A%20Movie&year=2000'),env:{TMDB_API_KEY:'key',...env}})).json();
 assert.deepEqual(await lookup(),{poster_url:null,tmdb_id:null,resolved:false,reason:'no_match'});
 behaviour=()=>new Response('boom',{status:500});
 assert.equal((await lookup()).reason,'tmdb_error');
});
test('poster without secret falls back; invalid query returns 400; web judge health is live',async()=>{
 const result=await getPoster({request:new Request('https://example.com/api/poster?title=Movie'),env:{}});const body=await result.json();assert.equal(body.resolved,false);assert.equal(body.reason,'missing_tmdb_key');
 assert.equal((await getPoster({request:new Request('https://example.com/api/poster?title=Movie&year=bad'),env:{}})).status,400);
 assert.equal(getJudge().status,200);assert.equal((await getJudge().json()).runtime,'cloudflare-pages');
});
