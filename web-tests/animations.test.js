import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Playback} from '../js/animations.js';
test('cosmetic typo backspaces and restores exact text; protected titles untouched',async()=>{
 globalThis.matchMedia=()=>({matches:false});
 const player=new Playback();player.wait=async()=>{};
 const values=[];const node={set textContent(value){values.push(value);}};
 await player.type(node,'the story',true);
 assert.ok(values.includes('tx'));assert.equal(values.at(-1),'the story');
 values.length=0;await player.type(node,'The Movie',true,()=>{},['The Movie']);assert.ok(!values.includes('Tx'));assert.equal(values.at(-1),'The Movie');
});
test('stop cancels waits and reduced motion restores full message immediately',async()=>{
 globalThis.matchMedia=()=>({matches:true});const player=new Playback();const node={};
 await player.type(node,'Unchanged content',true);assert.equal(node.textContent,'Unchanged content');
 player.stop();await assert.rejects(player.wait(1),{name:'AbortError'});
});
