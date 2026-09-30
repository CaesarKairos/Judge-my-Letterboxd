import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {archetypePhraseValid,normalizeJudgment} from '../functions/_lib/gemini.js';
import {buildScriptEngine,selectInteractions} from '../functions/_lib/editorial.js';
import {buildRelationships} from '../functions/_lib/relationships.js';
import {analyzeExport,userAffinityScore} from '../functions/_lib/letterboxd.js';
import {enrichGameInteractions,TMDB_MIN_VOTE_COUNT} from '../functions/_lib/tmdb-games.js';
import {blindRankOutcome,forcedTriageReaction} from '../js/game-results.js';

const film=(title,rating)=>({film_key:title.toLowerCase().replaceAll(' ','-'),title,year:'2000',rating});
const base=films=>({films,sessions:[],reviews:[],lists:[],topFour:[],watchlist:0,likes:{films:0}});

test('archetype gate rejects title lists and generic labels',()=>{
 const top=['Film A','Film B','Film C','Film D'];
 assert.equal(archetypePhraseValid(top.join(', '),top),false);
 assert.equal(archetypePhraseValid('film bro',top),false);
 assert.equal(archetypePhraseValid('cowboy lunar criando um androide',top),true);
});

test('global rating extremes remain measurements, never automatic editorial contrast',()=>{
 const profile=base([film('Film A',.5),film('Film B',5)]),analysis=analyzeExport(profile);
 assert.equal(analysis.measurements.rating_extremes.lowest.rating,.5);
 assert.equal(analysis.moments.some(row=>row.id==='rating-contrast'),false);
});

test('ubiquitous tag is context only and same-name tag/list exposes exceptions',()=>{
 const films=Array.from({length:100},(_,i)=>film(`Film ${i}`,i%10/2));
 const profile=base(films);profile.sessions=films.map((row,i)=>({film_key:row.film_key,tags:i<95?['My Canon']:[]}));profile.lists=[{name:'My Canon',description:'',films:films.slice(0,20),count:20}];
 const analysis=analyzeExport(profile),relation=buildRelationships(profile).relations.find(row=>row.type==='tag_list');
 assert.equal(analysis.moments.some(row=>row.type==='tag'&&row.tag==='My Canon'),false);
 assert.equal(relation.redundancy,1);assert.equal(relation.list_without_tag.length,0);assert.ok(relation.tag_without_list.length>0);
});

test('script engine does not fill maximum with weak findings',()=>{
 const strong=Array.from({length:7},(_,i)=>({id:`strong-${i}`,type:'stat',interestingness:.8,confidence:.8}));
 const weak=Array.from({length:10},(_,i)=>({id:`weak-${i}`,type:'tag',interestingness:.3,confidence:.9}));
 assert.equal(buildScriptEngine([...strong,...weak],100).length,7);
});

test('games require difficulty, affinity and variety, with at most two selected',()=>{
 const films=[film('Film A',5),film('Film B',4.5),film('Film C',5)],profile=base(films);profile.topFour=[films[0]];profile.sessions=films.flatMap(row=>[{film_key:row.film_key,tags:[]},{film_key:row.film_key,tags:[]}]);
 assert.ok(films.every(row=>userAffinityScore(row,profile)>.5));
 const candidates=[{id:'easy',type:'forced_triage',film_keys:films.map(f=>f.film_key),difficulty:.2},{id:'hard',type:'forced_triage',film_keys:films.map(f=>f.film_key),difficulty:.9},{id:'blind',type:'blind_rank',film_keys:films.map(f=>f.film_key),difficulty:.85},{id:'third',type:'defend_your_take',film_keys:films.map(f=>f.film_key),difficulty:.8}];
 assert.deepEqual(selectInteractions(candidates,profile).map(row=>row.id),['hard','blind']);
});

test('share implementation has both exact formats and no avatar contract',async()=>{
 const source=await readFile(new URL('../js/share-cards.js',import.meta.url),'utf8'),html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 assert.match(source,/1080,height:1350/);assert.match(source,/1080,height:1920/);
 assert.equal(/avatarUrl|card-avatar|avatar-picker/.test(source+html),false);
});

test('TMDb challenge labels its source and rejects a small public sample',async t=>{
 const films=[film('Film A',2),film('Film B',2.5),film('Film C',2)],game={id:'defend',type:'defend_your_take',film_keys:films.map(row=>row.film_key),films,difficulty:.9};let votes=TMDB_MIN_VOTE_COUNT-1;
 t.mock.method(globalThis,'fetch',async url=>{const value=new URL(String(url));if(value.pathname.includes('/search/movie')){const title=value.searchParams.get('query'),id=title==='Film D'?8:7;return Response.json({results:[{id,title,vote_count:votes}]});}const id=Number(value.pathname.split('/').at(-1));return Response.json({id,overview:'Context',genres:[],vote_average:8.1,vote_count:votes,runtime:100,credits:{crew:[]}});});
 assert.equal((await enrichGameInteractions([game],{TMDB_API_KEY:'key'},'pt-BR')).length,0);
 votes=TMDB_MIN_VOTE_COUNT+1;
 // Change the title to bypass the deliberately small in-memory cache entry.
 const eligible={...game,films:[film('Film D',2),...films.slice(1)]};
 const selected=await enrichGameInteractions([eligible],{TMDB_API_KEY:'key'},'pt-BR');
 assert.equal(selected[0].external_source_label,'média do público no TMDb');assert.equal(selected[0].tmdb.sample_sufficient,true);
});

test('game results use the actual assignment and historical ranking',()=>{
 const films=[film('Film A',5),film('Film B',4.5),film('Film C',4)];
 assert.equal(blindRankOutcome([1,2,3],films),'match');assert.equal(blindRankOutcome([2,1,3],films),'near_match');assert.equal(blindRankOutcome([3,2,1],films),'chaotic_mismatch');
 const hints=[{film_key:films[2].film_key,role_id:'retire',text:'Film C foi aposentado.'}];
 assert.equal(forcedTriageReaction([{film_key:films[2].film_key,role_id:'retire',rank:1}],hints),'Film C foi aposentado.');
});

test('Profile Review preserves distinct full and share word budgets',()=>{
 const line='palavra '.repeat(160),result=normalizeJudgment({greeting:'Oi',archetype_phrase:'',profile_reaction:'',profile_review:{full:line,share:line},reactions:[{id:'a',lines:['específica']}]},['a']);
 assert.ok(result.profile_review.full.split(/\s+/).length<=120);assert.ok(result.profile_review.full.length<=900);assert.equal(result.profile_review.share.split(/\s+/).length,60);assert.notEqual(result.profile_review.full,result.profile_review.share);
});
