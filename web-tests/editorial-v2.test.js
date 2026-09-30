import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {archetypePhraseValid,normalizeJudgment,writeJudgment} from '../functions/_lib/gemini.js';
import {buildScriptEngine,selectInteractions} from '../functions/_lib/editorial.js';
import {buildRelationships} from '../functions/_lib/relationships.js';
import {analyzeExport,userAffinityScore} from '../functions/_lib/letterboxd.js';
import {enrichGameInteractions,TMDB_MIN_VOTE_COUNT} from '../functions/_lib/tmdb-games.js';
import {blindRankOutcome,forcedTriageReaction} from '../js/game-results.js';
import {mergeModels} from '../functions/_lib/models.js';
import {selectEditorialMoments} from '../functions/_lib/analyst.js';

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

test('Profile Review has one canonical text for site and share',()=>{
 const line='palavra '.repeat(160),result=normalizeJudgment({greeting:'Oi',archetype_phrase:'',profile_reaction:'',profile_review:{text:line},reactions:[{id:'a',lines:['específica']}]},['a']);
 assert.ok(result.profile_review.text.split(/\s+/).length<=80);assert.ok(result.profile_review.text.length<=900);
 assert.equal('full' in result.profile_review,false);assert.equal('share' in result.profile_review,false);
});

test('model chain keeps every full model before Lite fallbacks',()=>{
 assert.deepEqual(mergeModels(['primary','explicit-lite','explicit-full'],['discovered-lite','discovered-full']),['primary','explicit-full','discovered-full','explicit-lite','discovered-lite']);
});

test('the chain is a ladder: complete Flash, other textual, previews, Lite last',()=>{
 const discovered=['gemini-flash-lite-latest','gemini-3-flash-preview','gemini-3.1-pro-preview','gemini-3.8-flash','gemini-3.7-flash','gemini-2.5-flash','gemini-omni-1.1-flash'];
 const chain=mergeModels(['gemini-flash-latest'],discovered);
 assert.equal(chain[0],'gemini-flash-latest');
 // Complete Flash first, newest generation first; previews and Lite never jump ahead of one.
 assert.deepEqual(chain.slice(1,5),['gemini-3.8-flash','gemini-3.7-flash','gemini-2.5-flash','gemini-omni-1.1-flash']);
 assert.ok(chain.indexOf('gemini-3-flash-preview')>chain.indexOf('gemini-2.5-flash'));
 assert.ok(chain.indexOf('gemini-3.1-pro-preview')>chain.indexOf('gemini-2.5-flash'));
 assert.equal(chain.at(-1),'gemini-flash-lite-latest');
});

test('a configured model is never duplicated and never invents a retired one',()=>{
 assert.deepEqual(mergeModels(['gemini-flash-latest','gemini-flash-latest'],['gemini-flash-latest','gemini-3.8-flash']),
   ['gemini-flash-latest','gemini-3.8-flash']);
 // gemini-2.5-flash is only considered when the operator configured it or discovery confirmed it.
 assert.equal(mergeModels(['gemini-flash-latest'],['gemini-3.8-flash','gemini-3-flash-preview']).includes('gemini-2.5-flash'),false);
 assert.equal(mergeModels(['gemini-flash-latest']).includes('gemini-2.5-flash'),false);
 assert.deepEqual(mergeModels(['gemini-flash-latest','gemini-2.5-flash'],[]),['gemini-flash-latest','gemini-2.5-flash']);
 // Discovery is the source of fallbacks, so the whole catalogue order survives the merge.
 const wide=Array.from({length:12},(_,index)=>`gemini-3.${index+1}-flash`);
 assert.equal(mergeModels(['gemini-flash-latest'],wide).length,13);
});

test('Analyst failure never promotes deterministic candidates',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:{}},{status:503}));
 const profile={...base([film('Film A',5)]),handle:'synthetic',name:'Synthetic'},analysis={moments:[{id:'measurement',type:'stat',facts:'one measurement'}],overview:{},relationships:{},review_style:null,review_coverage:{}};
 const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:{GEMINI_API_KEY:'key',GEMINI_ANALYST_MODEL:'primary',GEMINI_MODEL_DISCOVERY:'0'}});
 assert.equal(result.status,'failed');assert.deepEqual(result.selected,[]);assert.ok(result.attempts.length>0);
});

const strictPayload=()=>({greeting:'Oi.',archetype_phrase:'um robô fugindo com caubóis',profile_reaction:'',opening:{greeting:['Oi.'],archetype_lead:'Já entendi.',archetype_phrase:'um robô fugindo com caubóis',archetype_after:['Específico demais.'],username_line:'Vou ficar com synthetic.',taste_bit:{enabled:true,lead:'Essas escolhas são',strike:'duvidosas',correction:'corajosas',tail:'para dizer o mínimo.'},judge_claim:'Eu julgo daqui.',transition:['Vamos investigar.']},closer:['Fim.'],profile_review:{text:'Seu padrão de notas contradiz suas reviews e reaparece nas reassistidas.',evidence_ids:['a','b']},reactions:[{id:'a',lines:['Film A contradiz a própria review.']},{id:'b',lines:['Film B volta e mantém a nota.']} ]});

test('strict opening rejects missing strike and early username',()=>{
 const films=['A','B','C','D'].map(title=>film(`Film ${title}`,5)),missing=strictPayload();missing.opening.taste_bit.strike='';
 assert.equal(normalizeJudgment(missing,['a','b'],films,{strict:true,handle:'synthetic'}).ok,false);
 const early=strictPayload();early.opening.greeting=['Oi, synthetic.'];assert.equal(normalizeJudgment(early,['a','b'],films,{strict:true,handle:'synthetic'}).ok,false);
 assert.equal(normalizeJudgment(strictPayload(),['a','b'],films,{strict:true,handle:'synthetic'}).ok,true);
});

test('generic Profile Review is rejected while grounded profile behavior passes',()=>{
 const generic=strictPayload();generic.profile_review.text='Boa direção, bom roteiro, bela fotografia.';
 assert.equal(normalizeJudgment(generic,['a','b'],[],{strict:true}).ok,false);
 assert.equal(normalizeJudgment(strictPayload(),['a','b'],[],{strict:true}).ok,true);
});

test('complete Lite is complete but quality degraded; partial means missing content',async t=>{
 const profile={...base([]),handle:'synthetic'},analysis={moments:[{id:'a',film:{title:'Film A'},facts:'Film A fact'},{id:'b',film:{title:'Film B'},facts:'Film B fact'}],overview:{},review_style:null,callbacks:[],interactions:[]};let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;if(calls<=2)return Response.json({error:{}},{status:503});return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({greeting:'Oi.',archetype_phrase:'',profile_reaction:'',reactions:[{id:'a',lines:['Film A muda o padrão.']},{id:'b',lines:['Film B quebra a regra.']}]})}]}}]});});
 const complete=await writeJudgment({profile,analysis,locale:'pt-BR',env:{GEMINI_API_KEY:'key',GEMINI_WRITER_MODEL:'primary',GEMINI_WRITER_FALLBACK_MODELS:'backup-lite',GEMINI_MODEL_DISCOVERY:'0',__TEST_SKIP_ANALYST:true}});
 assert.equal(complete.generation_status,'complete');assert.equal(complete.model_quality,'fallback_lite');assert.equal(complete.quality_degraded,true);
});

test('eight of ten recovered reactions are genuinely partial',async t=>{
 const moments=Array.from({length:10},(_,index)=>({id:`beat-${index}`,film:{title:`Film ${index}`},facts:`Film ${index} fact`})),profile={...base([]),handle:'synthetic'},analysis={moments,overview:{},review_style:null,callbacks:[],interactions:[]};
 t.mock.method(globalThis,'fetch',async()=>Response.json({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:JSON.stringify({greeting:'Oi.',archetype_phrase:'',profile_reaction:'',reactions:moments.slice(0,8).map(row=>({id:row.id,lines:[`${row.film.title} quebra o padrão.`]}))})}]}}]}));
 const result=await writeJudgment({profile,analysis,locale:'pt-BR',env:{GEMINI_API_KEY:'key',GEMINI_WRITER_MODEL:'primary',GEMINI_MODEL_DISCOVERY:'0',__TEST_SKIP_ANALYST:true}});
 assert.equal(result.generation_status,'partial');assert.equal(result.reactions.length,8);assert.equal(result.quality_degraded,false);
});

test('generic reaction majority triggers Writer repair',async t=>{
 const moments=['A','B','C'].map(letter=>({id:letter.toLowerCase(),film:{title:`Film ${letter}`},facts:`Film ${letter} fact`})),profile={...base([]),handle:'synthetic'},analysis={moments,overview:{},review_style:null,callbacks:[],interactions:[]};let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;const generic={greeting:'Oi.',archetype_phrase:'',profile_reaction:'',reactions:moments.map(row=>({id:row.id,lines:['Isso diz muito sobre você.']}))},specific={...generic,reactions:moments.map(row=>({id:row.id,lines:[`${row.film.title} contradiz a própria regra.`]}))};return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(calls===1?generic:specific)}]}}]});});
 const result=await writeJudgment({profile,analysis,locale:'pt-BR',env:{GEMINI_API_KEY:'key',GEMINI_WRITER_MODEL:'primary',GEMINI_MODEL_DISCOVERY:'0',__TEST_SKIP_ANALYST:true}});assert.equal(result.generation_status,'complete');assert.equal(calls,2);
});
