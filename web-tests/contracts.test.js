import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateScript} from '../js/utils.js';
import {matchMovie,onRequestGet} from '../functions/api/poster.js';
import {onRequestPost} from '../functions/api/judge.js';
test('real fixture preserves all original narrative and evidence',()=>{
 const demo=JSON.parse(readFileSync('data/demo-presentation.json','utf8'));validateScript(demo);
 const original=JSON.parse(readFileSync('output/presentation_script.json','utf8'));
 assert.deepEqual(demo.events.map(({cue,role,...e})=>e),original.events.map(({cue,role,...e})=>e));
 assert.equal(demo.opening.top_four.length,4);assert.equal(demo.events[3].cue,'top_four_reveal');assert.equal(demo.events[4].role,'archetype_phrase');
});
test('invalid versions and shapes rejected, future events allowed',()=>{
 assert.throws(()=>validateScript({version:'v2',events:[]}));assert.throws(()=>validateScript({version:'presentation-v1',events:[{type:'message',segments:null}]}));
 assert.doesNotThrow(()=>validateScript({version:'presentation-v1',events:[{type:'future'}]}));
});
test('poster matches require exact identity and reject ambiguous remakes',()=>{
 const movie={id:1,title:'A Movie',release_date:'2000-01-01'};
 assert.equal(matchMovie([movie],'A Movie','2000'),movie);assert.equal(matchMovie([movie],'Another Movie','2000'),null);assert.equal(matchMovie([movie],'A Movie','2001'),null);
 assert.equal(matchMovie([movie,{...movie,id:2}],'A Movie','2000'),null);
});
test('poster without secret falls back; invalid query returns 400; judge is explicitly unavailable',async()=>{
 const result=await onRequestGet({request:new Request('https://example.com/api/poster?title=Movie'),env:{}});assert.equal((await result.json()).resolved,false);
 assert.equal((await onRequestGet({request:new Request('https://example.com/api/poster?title=Movie&year=bad'),env:{}})).status,400);
 assert.equal(onRequestPost().status,501);
});
