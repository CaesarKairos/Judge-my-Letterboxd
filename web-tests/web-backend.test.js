import {test} from 'node:test';
import assert from 'node:assert/strict';
import {unzipText} from '../functions/_lib/zip.js';
import {parseExport,analyzeExport} from '../functions/_lib/letterboxd.js';
import {buildPresentation} from '../functions/_lib/judge.js';
import {salvageJson,normalizeJudgment,writeJudgment} from '../functions/_lib/gemini.js';
import {buildRelationships} from '../functions/_lib/relationships.js';
import {materializeCandidates,buildScriptEngine,callbackCandidates} from '../functions/_lib/editorial.js';

import {onRequestPost} from '../functions/api/judge.js';

const encoder=new TextEncoder();
const concat=parts=>{const size=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(size);let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;};
const record=(size,write)=>{const bytes=new Uint8Array(size);write(new DataView(bytes.buffer));return bytes;};
function storedZip(files){
 const locals=[],central=[];let offset=0;
 for(const [name,text] of Object.entries(files)){
  const n=encoder.encode(name),data=encoder.encode(text);
  const header=record(30,v=>{v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,n.length,true);});
  locals.push(header,n,data);
  const directory=record(46,v=>{v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);v.setUint32(20,data.length,true);v.setUint32(24,data.length,true);v.setUint16(28,n.length,true);v.setUint32(42,offset,true);});
  central.push(directory,n);offset+=header.length+n.length+data.length;
 }
 const centralBytes=concat(central),end=record(22,v=>{v.setUint32(0,0x06054b50,true);v.setUint16(8,Object.keys(files).length,true);v.setUint16(10,Object.keys(files).length,true);v.setUint32(12,centralBytes.length,true);v.setUint32(16,offset,true);});
 return concat([...locals,centralBytes,end]);
}
const fixture={
 'profile.csv':'Username,Favorite Films\ncritic,"https://boxd.it/a, https://boxd.it/b, https://boxd.it/c, https://boxd.it/d"\n',
 'watched.csv':'Date,Name,Year,Letterboxd URI\n2026-01-01,Alpha,2000,https://boxd.it/a\n2026-01-01,Beta,2001,https://boxd.it/b\n2026-01-01,Gamma,2002,https://boxd.it/c\n2026-01-01,Delta,2003,https://boxd.it/d\n',
 'ratings.csv':'Date,Name,Year,Letterboxd URI,Rating\n2026-01-01,Alpha,2000,https://boxd.it/a,1\n2026-01-01,Beta,2001,https://boxd.it/b,5\n',
 'diary.csv':'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2026-01-01,Beta,2001,https://boxd.it/b,5,,comfort,2026-01-01\n2026-02-01,Beta,2001,https://boxd.it/b,5,Yes,comfort,2026-02-01\n',
 'reviews.csv':'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n2026-01-01,Alpha,2000,https://boxd.it/a,1,,"Dito isso: ruim.<blockquote>""Nunca mais."" — Alpha</blockquote>",,2026-01-01\n2026-02-01,Beta,2001,https://boxd.it/b,5,,"Dito isso: perfeito.",,2026-02-01\n',
 'lists/favorites.csv':'Letterboxd list export v7\nDate,Name,Tags,URL,Description\n2026-01-01,My list,,https://boxd.it/list,Description\n\nPosition,Name,Year,URL,Description\n1,Beta,2001,https://boxd.it/b,\n'
};

test('ZIP parser and independent web analyzer read an official export shape',async()=>{
 const files=await unzipText(storedZip(fixture).buffer),profile=parseExport(files),analysis=analyzeExport(profile,'pt-BR');
 assert.equal(profile.handle,'critic');assert.equal(profile.topFour.length,4);assert.equal(profile.reviews.length,2);
 assert.ok(analysis.moments.some(row=>row.type==='film_pair'));assert.ok(analysis.moments.some(row=>row.type==='rewatch'));assert.ok(analysis.moments.some(row=>row.type==='phrase'));
 // Evidence sent to the model is parsed, so a quoted review never leaks its markup.
 const quoted=profile.reviews.find(review=>review.segments.some(segment=>segment.type==='blockquote'));
 assert.ok(quoted);assert.equal(quoted.text.includes('<'),false);
 assert.equal(quoted.segments.at(-1).text,'"Nunca mais." — Alpha');
 assert.equal(JSON.stringify(analysis.moments).includes('<blockquote>'),false);
});
test('list members and tag cards show the current rating of the film',async()=>{
 // A list CSV has no rating column and a diary line only holds that session's score, so both are
 // resolved through the film registry: without that lookup every member rendered as "not rated".
 const local={
  'profile.csv':'Username,Favorite Films\ncritic,\n',
  'watched.csv':'Date,Name,Year,Letterboxd URI\n2026-01-01,Alpha,2000,https://boxd.it/a\n2026-01-01,Beta,2001,https://boxd.it/b\n2026-01-01,Gamma,2002,https://boxd.it/c\n',
  'ratings.csv':'Date,Name,Year,Letterboxd URI,Rating\n2026-01-01,Alpha,2000,https://boxd.it/a,5\n2026-01-01,Beta,2001,https://boxd.it/b,2\n',
  'diary.csv':'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2026-01-01,Alpha,2000,https://boxd.it/a,4.5,,comfort,2026-01-01\n2026-01-02,Beta,2001,https://boxd.it/b,,,comfort,2026-01-02\n',
  'reviews.csv':'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n2026-01-01,Alpha,2000,https://boxd.it/a,4.5,,"Uma linha.",,2026-01-01\n',
  'lists/duo.csv':'Letterboxd list export v7\nDate,Name,Tags,URL,Description\n2026-01-01,Duo,,https://boxd.it/list,Assistido\n\nPosition,Name,Year,URL,Description\n1,Alpha,2000,https://boxd.it/a,\n2,Gamma,2002,https://boxd.it/c,\n3,Never rated,2010,https://boxd.it/z,\n'
 };
 const profile=parseExport(await unzipText(storedZip(local).buffer));
 assert.deepEqual(profile.lists[0].films.map(film=>[film.title,film.rating]),[['Alpha',5],['Gamma',null],['Never rated',null]]);
 // The current rating is the one from ratings.csv: the 4.5 of that review and of that diary line
 // never replaces it, and a member outside watched/ratings/diary/reviews stays unrated.
 assert.deepEqual(profile.films.map(film=>[film.title,film.rating]),[['Alpha',5],['Beta',2],['Gamma',null]]);
 assert.equal(profile.films.length,3);
 const analysis=analyzeExport(profile,'pt-BR');
 assert.equal(analysis.moments.some(moment=>moment.type==='list'||moment.type==='tag'),false,'bare list/tag counts are evidence, not beats');
});
test('tag × list relationships preserve intersection and coverage for editorial selection',()=>{
 const profile={films:[1,2,3,4,5].map(id=>({film_key:String(id),rating:id})),sessions:[2,3,4].map(id=>({film_key:String(id),tags:['Tag B']})),lists:[{name:'Lista A',films:[1,2,3,4,5].map(id=>({film_key:String(id)}))}]};
 const relation=buildRelationships(profile).relations.find(row=>row.type==='tag_list');
 assert.equal(relation.intersection,3);assert.equal(relation.list_count,5);assert.equal(relation.tag_count,3);assert.equal(relation.coverage,.6);
});
test('Pages Function falls back across models and returns Presentation without Python',async t=>{
 const preview=analyzeExport(parseExport(await unzipText(storedZip(fixture).buffer)),'pt-BR');
 const writing={greeting:'Certo.',archetype_phrase:'quatro décadas e nenhum consenso',profile_reaction:'Quatro filmes e duas reviews. Corajoso.',reactions:preview.moments.map(moment=>({id:moment.id,lines:[`Detalhe específico de ${moment.id}.`]}))};
 let calls=0;t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;assert.match(String(url),/generativelanguage\.googleapis\.com/);assert.equal(options.headers['x-goog-api-key'],'secret');if(calls<3)return Response.json({error:{message:'busy'}},{status:503});return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(writing)}]}}]});});
 const form=new FormData();form.set('locale','pt-BR');form.set('export',new File([storedZip(fixture)],'letterboxd.zip',{type:'application/zip'}));
 const result=await onRequestPost({request:new Request('https://example.com/api/judge',{method:'POST',body:form}),env:{GEMINI_API_KEY:'secret',GEMINI_MODEL:'test-model',GEMINI_FALLBACK_MODELS:'backup-model',__TEST_SKIP_ANALYST:true,__TEST_PIPELINE_MODE:'curated'}});
 assert.equal(result.status,200);const script=await result.json();assert.equal(script.version,'presentation-v2');assert.equal(script.render.runtime,'cloudflare-pages');assert.equal(script.render.served_model,'backup-model');assert.equal(script.render.ai_generation,'complete');assert.equal(script.render.model_quality,'fallback');assert.equal(script.ai.calls,3);assert.equal(script.opening.top_four.length,4);assert.ok(script.events.some(event=>event.cue==='top_four_reveal'));assert.ok(script.events.some(event=>event.type==='film_pair'));
});

test('Pages Function reports missing secret and malformed exports clearly',async()=>{
 let form=new FormData();form.set('export',new File([storedZip(fixture)],'letterboxd.zip'));
 let result=await onRequestPost({request:new Request('https://example.com/api/judge',{method:'POST',body:form}),env:{__TEST_PIPELINE_MODE:'curated'}});assert.equal(result.status,503);assert.equal((await result.json()).error,'missing_gemini_key');
 form=new FormData();form.set('export',new File([storedZip({'other.csv':'A\nB\n'})],'letterboxd.zip'));
 result=await onRequestPost({request:new Request('https://example.com/api/judge',{method:'POST',body:form}),env:{GEMINI_API_KEY:'x',__TEST_PIPELINE_MODE:'curated'}});assert.equal(result.status,422);
});

test('a 429 in one request never poisons a later request in the same worker isolate',async t=>{
 const sharedEnv={GEMINI_API_KEY:'secret',GEMINI_MODEL:'primary',GEMINI_FALLBACK_MODELS:'primary',GEMINI_MODEL_DISCOVERY:'0',__TEST_SKIP_ANALYST:true,__TEST_PIPELINE_MODE:'curated'};let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;if(calls===1)return Response.json({error:{status:'RESOURCE_EXHAUSTED',message:'quota exceeded'}},{status:429});
  const preview=analyzeExport(parseExport(await unzipText(storedZip(fixture).buffer)),'pt-BR');
  return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({greeting:'Certo.',archetype_phrase:'',profile_reaction:'',reactions:preview.moments.map(moment=>({id:moment.id,lines:[`Detalhe de ${moment.id}.`]}))})}]}}]});});
 const request=()=>{const form=new FormData();form.set('locale','pt-BR');form.set('export',new File([storedZip(fixture)],'letterboxd.zip',{type:'application/zip'}));return new Request('https://example.com/api/judge',{method:'POST',body:form});};
 const first=await onRequestPost({request:request(),env:sharedEnv});assert.equal(first.status,503);assert.equal((await first.json()).reason,'quota_exceeded');
 const second=await onRequestPost({request:request(),env:sharedEnv});assert.equal(second.status,200);assert.equal((await second.json()).version,'presentation-v2');assert.equal(calls,3);
});

test('Pages Function stops after Analyst failure and never calls Writer',async t=>{
 let writerCalled=false,calls=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls++;
  const request=JSON.parse(options.body),prompt=request.contents?.[0]?.parts?.[0]?.text||'';
  if(prompt.includes('ROTEIRO INTEIRO')||prompt.includes('Final Writer'))writerCalled=true;
  return Response.json({error:{message:'unavailable'}},{status:503});
 });
 const form=new FormData();form.set('locale','pt-BR');form.set('export',new File([storedZip(fixture)],'letterboxd.zip',{type:'application/zip'}));
 const result=await onRequestPost({request:new Request('https://example.com/api/judge',{method:'POST',body:form}),env:{GEMINI_API_KEY:'secret',GEMINI_ANALYST_MODEL:'analyst-only',GEMINI_MODEL_DISCOVERY:'0',__TEST_PIPELINE_MODE:'curated'}});
 const body=await result.json();
 assert.equal(result.status,503);assert.equal(body.error,'analyst_unavailable');assert.equal(body.stage,'analyst');assert.equal(body.generation_meta.analyst.status,'failed');
 assert.equal(body.deterministic_analysis_available,true);assert.equal(writerCalled,false);
 // One model, one short retry after the 5xx, and then Analyst FAILED: the Writer never runs and
 // the deterministic pool is not promoted to a judgment.
 assert.equal(calls,2);assert.equal(body.attempts.length,2);assert.equal(body.reason,'no_usable_analysis');
 assert.ok(body.attempts.every(row=>row.provider_error.code===503));
});


test('judge lines become quote segments and AI durations reach the queue',async()=>{
 const files=await unzipText(storedZip(fixture).buffer),profile=parseExport(files),analysis=analyzeExport(profile,'pt-BR');
 const beat=analysis.moments[0].id;
 const writing={greeting:'Certo.',archetype_phrase:'',profile_reaction:'',reactions:[{id:beat,lines:['Você escreveu <blockquote>"Nunca mais."</blockquote> e ficou por isso.','Segunda linha.'],
  evidence_pause:'long',after_evidence:'medium',typing:'long',between_lines:'long',after_reaction:'short'}]};
 const script=buildPresentation({profile,analysis,writing,locale:'pt-BR'});
 const start=script.events.findIndex(event=>event.type==='phrase');
 const quote=script.events[start+5];
 assert.equal(quote.type,'message');
 assert.deepEqual(quote.segments.map(segment=>[segment.effect,segment.text]),[['none','Você escreveu'],['quote','"Nunca mais."'],['none','e ficou por isso.']]);
 assert.equal(JSON.stringify(script.events).includes('<blockquote>'),false);
 // The model directs the rhythm: suspense, reading time, hesitation, breath.
 assert.deepEqual(script.events.slice(start-1,start+9).map(event=>`${event.type}:${event.duration||''}`),
  ['pause:long','phrase:','review_quote:','review_quote:','pause:medium','typing:long','message:','pause:long','message:','pause:short']);
 assert.deepEqual(script.beats[0].lines.map(line=>line.effect),['none','quote','none','none']);
});

const judge=extra=>{const form=new FormData();form.set('locale','pt-BR');form.set('export',new File([storedZip(fixture)],'letterboxd.zip',{type:'application/zip'}));return onRequestPost({request:new Request('https://example.com/api/judge',{method:'POST',body:form}),env:{GEMINI_API_KEY:'secret',__TEST_SKIP_ANALYST:true,__TEST_PIPELINE_MODE:'curated',...extra}});};
const readExport=async()=>{const files=await unzipText(storedZip(fixture).buffer),profile=parseExport(files);return {profile,analysis:analyzeExport(profile,'pt-BR')};};

test('a cut model answer is salvaged and then repaired instead of failing',async t=>{
 const {profile,analysis}=await readExport(),ids=analysis.moments.map(moment=>moment.id);
 const cut=`{"greeting":"Certo.","archetype_phrase":"quatro atos","profile_reaction":"","reactions":[{"id":"${ids[0]}","lines":["Primeira linha.","Segunda`;
 const complete={greeting:'Certo.',archetype_phrase:'quatro atos',profile_reaction:'',reactions:ids.map(id=>({id,lines:[`Sobre ${id}.`],evidence_pause:'long',after_evidence:'long',typing:'medium',between_lines:'short',after_reaction:'long'}))};
 const prompts=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{prompts.push(JSON.parse(options.body).contents[0].parts[0].text);
  if(prompts.length===1)return Response.json({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:cut}]}}]});
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(complete)}]}}]});});
 const result=await judge();assert.equal(result.status,200);
 const script=await result.json();
 // The truncated reaction is kept, the missing ids are requested again in one more call.
 assert.equal(prompts.length,2);assert.match(prompts[1],/rejected/);assert.match(prompts[1],/still required/i);
 assert.equal(script.render.quality_degraded,false);assert.equal(script.render.salvaged,true);assert.equal(script.ai.warnings.length,0);
 assert.equal(script.beats.length,ids.length);
 assert.deepEqual(script.beats[0].lines.map(line=>line.text),[`Sobre ${ids[0]}.`]);
 assert.equal(script.beats[0].event_count>0,true);
});

test('a greeting without editorial coverage becomes AI_FAILED, never a silent judgment',async t=>{
 const {analysis}=await readExport();
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{"greeting":"Oi'}]}}]});});
 const result=await judge();assert.equal(result.status,503);
 const body=await result.json();
 assert.ok(calls>=2);assert.equal(body.error,'writer_unavailable');assert.equal(body.stage,'writer');assert.equal(body.retryable,true);
 assert.equal(body.deterministic_analysis_available,true);
 assert.equal(body.analysis.stats.length>0,true);
 assert.equal(JSON.stringify(body).includes('top_four'),false);
});

test('an unreadable model answer retries and becomes AI_FAILED',async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'desculpe, mas nao vou responder em JSON'}]}}]});});
 const result=await judge();assert.equal(result.status,503);const body=await result.json();
 assert.ok(calls>=2);assert.equal(body.error,'writer_unavailable');assert.equal(body.stage,'writer');assert.equal(body.retryable,true);
});


test('a model that rejects thinkingConfig is retried without it',async t=>{
 const {analysis}=await readExport(),ids=analysis.moments.map(moment=>moment.id);
 const complete={greeting:'Certo.',archetype_phrase:'',profile_reaction:'',reactions:ids.map(id=>({id,lines:[`Sobre ${id}.`]}))};
 const configs=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{configs.push(JSON.parse(options.body).generationConfig);
  if(configs.length===1)return Response.json({error:{message:'Request contains an invalid argument.'}},{status:400});
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(complete)}]}}]});});
 const result=await judge();assert.equal(result.status,200);
 // The output budget is never the reason the reply gets cut; a rejected thinking
 // configuration is dropped on the spot instead of failing the whole judgment.
 assert.deepEqual(configs[0].thinkingConfig,{thinkingBudget:0});assert.equal(configs[0].maxOutputTokens,8192);
 assert.equal(configs[1].thinkingConfig,undefined);assert.equal(configs[1].maxOutputTokens,8192);
 const script=await result.json();assert.equal(script.render.quality_degraded,false);assert.equal(script.beats.length,ids.length);
});

test('salvageJson keeps the readable part of a cut reply',()=>{
 assert.deepEqual(salvageJson('{"greeting":"Oi","reactions":[{"id":"a","lines":["b","c'),{greeting:'Oi',reactions:[{id:'a',lines:['b','c']}]});
 assert.deepEqual(salvageJson('```json\n{"a":"b"}\n```'),{a:'b'});
 assert.deepEqual(salvageJson('aqui vem texto {"a":"b"} e mais prosa'),{a:'b'});
 assert.equal(salvageJson('nenhum json aqui'),null);
 assert.equal(salvageJson('{"a":'),null);
 // Braces inside a string and a dangling separator must not confuse the repair.
 assert.deepEqual(salvageJson('{"a":"}{[]","b":'),{a:'}{[]'});
 assert.equal(salvageJson('{"a":"linha\nlinha2').a,'linha linha2');
 assert.equal(salvageJson('{"a":"diz \\"oi').a,'diz "oi');
});

test('normalizeJudgment fills missing rhythm and flags unusable reactions',()=>{
 const ids=['a','b'];
 const ok=normalizeJudgment({greeting:'Certo.',archetype_phrase:'x',profile_reaction:'y',reactions:[{id:'a',lines:'uma linha'},{id:'b',lines:['b1'],evidence_pause:'long',typing:'nonsense'}]},ids);
 assert.equal(ok.ok,true);assert.deepEqual(ok.missing,[]);assert.deepEqual(ok.problems,[]);
 assert.deepEqual(ok.reactions.find(row=>row.id==='a'),{id:'a',lines:['uma linha'],after_beat:[],evidence_pause:'medium',after_evidence:'long',typing:'short',between_lines:'medium',after_reaction:'medium'});
 assert.equal(ok.reactions.find(row=>row.id==='b').evidence_pause,'long');assert.equal(ok.reactions.find(row=>row.id==='b').typing,'short');
 const bad=normalizeJudgment({greeting:'',archetype_phrase:'x',profile_reaction:'y',reactions:[{id:'a',lines:['x']},{id:'extra',lines:['x']},{id:'a'}]},ids);
 assert.equal(bad.ok,false);assert.deepEqual(bad.missing,['b']);
 assert.equal(bad.problems.some(problem=>problem.includes('unknown evidence id')),true);
 assert.equal(bad.problems.some(problem=>problem.includes('greeting is empty')),true);
 assert.equal(normalizeJudgment(null,ids).ok,false);assert.equal(normalizeJudgment('nope',ids).ok,false);
});

// A richer account: twenty-four films, twelve members spread over six months, a tag that covers
// three films of a five-film list, rated drift, a repeat with a real rating move and ten reviews
// of different lengths. It exists to prove the pool, the relationships and the Script Engine, not
// to look like a specific account.
const richExport=()=>{
 const films=Array.from({length:24},(_,index)=>[`Film ${index+1}`,String(2000+index)]),uri=index=>`https://boxd.it/rich${index+1}`;
 const rows=header=>[header,...films.map(([name,year],index)=>`2026-01-01,${name},${year},${uri(index)}`)].join('\n')+'\n';
 const rated=header=>[header,...films.map(([name,year],index)=>`2026-01-01,${name},${year},${uri(index)},${[5,4,3,2,1,2.5][index%6]}`)].join('\n')+'\n';
 const diary=['Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date'];
 for(let index=0;index<13;index++){
  const film=index%12,name=films[film][0],year=films[film][1],month=String(1+index%6).padStart(2,'0');
  const tags=(film>=1&&film<=3?'cinema':'')+(film===3?',solo':'');
  diary.push(`2026-${month}-0${1+index%2},${name},${year},${uri(film)},${2+Math.round((index/12)*3)},${index===0||index===12?'Yes':''},${tags},2026-${month}-0${1+index%2}`);
 }
 const reviews=['Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date'];
 for(let index=0;index<10;index++){
  const name=films[index][0],year=films[index][1],month=String(1+index%6).padStart(2,'0');
  reviews.push(`2026-${month}-01,${name},${year},${uri(index)},${[5,4,3,2,1,2.5][index%6]},,"${'palavra '.repeat(4+index*5).trim()}",${index===3?'cinema':''},2026-${month}-01`);
 }
 return {
  'profile.csv':'Username,Favorite Films\nrich,"https://boxd.it/rich1, https://boxd.it/rich2, https://boxd.it/rich3, https://boxd.it/rich4"\n',
  'watched.csv':rows('Date,Name,Year,Letterboxd URI'),'ratings.csv':rated('Date,Name,Year,Letterboxd URI,Rating'),
  'diary.csv':diary.join('\n')+'\n','reviews.csv':reviews.join('\n')+'\n',
  'watchlist.csv':'Date,Name,Year,Letterboxd URI\n2026-01-01,Backlog,1990,https://boxd.it/back\n',
  'likes/films.csv':'Date,Name,Year,Letterboxd URI\n2026-01-01,Film 2,2001,https://boxd.it/rich2\n',
  'comments.csv':'Date,Name,Year,Letterboxd URI,Comment\n2026-01-01,Film 1,2000,https://boxd.it/rich1,Comentario\n',
  'lists/cinema-night.csv':'Letterboxd list export v7\nDate,Name,Tags,URL,Description\n2026-01-01,Cinema night,,https://boxd.it/list,Serious description\n\nPosition,Name,Year,URL,Description\n1,Film 1,2000,https://boxd.it/rich1,\n2,Film 2,2001,https://boxd.it/rich2,\n3,Film 3,2002,https://boxd.it/rich3,\n4,Film 4,2003,https://boxd.it/rich4,\n5,Film 5,2004,https://boxd.it/rich5,\n'
 };
};

test('a rich account becomes a wide pool, real relationships and a long balanced script',async()=>{
 const files=await unzipText(storedZip(richExport()).buffer),profile=parseExport(files),analysis=analyzeExport(profile,'pt-BR');
 assert.equal(profile.inventory.files_processed,9);assert.equal(profile.inventory.unknown_files.length,0);
 assert.ok(analysis.moments.length>=8,`candidate pool ${analysis.moments.length}`);
 const types=new Set(analysis.moments.map(moment=>moment.type));
 for(const wanted of ['film_pair','review_quote','rewatch','phrase'])assert.ok(types.has(wanted),wanted);
 // Tag × list keeps the intersection and the coverage the Analyst will read.
 const relation=analysis.relationships.relations.find(row=>row.type==='tag_list'&&row.tag==='cinema');
 assert.equal(relation.intersection,3);assert.equal(relation.list_count,5);assert.equal(Math.round(relation.coverage*100),60);
 const tagList=analysis.moments.find(moment=>moment.id.startsWith('tag-list-'));
 assert.equal(tagList.stats.find(row=>row.key==='films').value,3);
 // A contrast pair only exists inside a shared context, never as bare min versus max.
 assert.ok(analysis.moments.some(moment=>moment.id.startsWith('contrast-tag-')));
 assert.ok(analysis.moments.some(moment=>moment.id.startsWith('contrast-list-')));
 // Temporal measurements only appear once the dated rows can support halves.
 assert.ok(analysis.temporal.busiest_period.sessions>=2);assert.ok(analysis.temporal.rating_drift);
 assert.ok(analysis.temporal.verbosity_drift);assert.equal(analysis.temporal.rewatch_moves.length,1);
 // The spotlight is a spread of reviews, never two candidates pointing at the same text.
 const spotlight=analysis.moments.filter(moment=>moment.type==='review_quote');
 for(const id of ['quote-review-1','quote-review-2','quote-longest','quote-lowest'])assert.ok(analysis.moments.some(moment=>moment.id===id),id);
 assert.ok(spotlight.length>=4,`spotlight ${spotlight.length}`);
 assert.equal(new Set(spotlight.map(moment=>moment.review.review_id)).size,spotlight.length);
 const materialized=materializeCandidates(analysis.moments,analysis.moments);
 const beats=buildScriptEngine(materialized,profile.reviews.length),rich=buildScriptEngine(materialized,120);
 assert.ok(beats.length>=7&&beats.length<=8,`beats ${beats.length}`);
 assert.ok(rich.length>=8&&rich.length<=12,`rich beats ${rich.length}`);
 const ids=new Set(analysis.moments.map(moment=>moment.id));
 assert.equal(new Set(rich.map(moment=>moment.id)).size,rich.length);
 assert.ok(rich.every(moment=>ids.has(moment.id)));
 assert.ok(new Set(rich.map(moment=>moment.type)).size>=4);
 assert.ok(callbackCandidates(rich).length>0);
});



test('Profile Review and explainability are contracted, measured and secret-free',async()=>{
 const files=await unzipText(storedZip(richExport()).buffer),profile=parseExport(files),analysis=analyzeExport(profile,'pt-BR');
 const moment=analysis.moments[0],outcome=normalizeJudgment({greeting:'Certo.',archetype_phrase:'um titulo',profile_reaction:'uma reacao',closer:['fim'],
  profile_review:{lead:'Se eu falasse de você como você fala dos filmes...',text:'palavra '.repeat(200),style_features_used:['blockquotes','frase recorrente']},
  opening:{greeting:['certo.'],archetype_lead:'Você deve ser o...',archetype_phrase:'um titulo',archetype_after:['...'],username_line:'Pode ser só rich.',transition:['Deixa eu ver.']},
  reactions:[{id:moment.id,lines:['uma linha']}]},[moment.id]);
 assert.equal(outcome.profile_review.lead,'Se eu falasse de você como você fala dos filmes...');
 assert.ok(outcome.profile_review.text.length<=900);
 assert.deepEqual(outcome.profile_review.style_features_used,['blockquotes','frase recorrente']);
 const selected=analysis.moments.slice(0,3).map(row=>({...row,observation:`observacao ${row.id}`,why_interesting:'motivo'}));
 const script=buildPresentation({profile,analysis,writing:{...outcome,opening:outcome.opening},locale:'pt-BR',
  analyst:{status:'complete',model:'analyst-model',candidate_count:analysis.moments.length,selected,attempts:[{model:'analyst-model',status:200}]}});
 assert.equal(script.version,'presentation-v2');
 assert.equal(script.profile_review.lead,outcome.profile_review.lead);
 // Explainability reports what was measured, not what the model said.
 assert.equal(script.explainability.files_processed,profile.inventory.files_processed);
 assert.ok(script.explainability.files_in_zip>=script.explainability.files_processed);
 assert.equal(script.explainability.profile_summary.watched,profile.films.length);
 assert.equal(script.explainability.measurements.length,analysis.stats.length);
 // candidates_found is what the deterministic pass found; selected is what reached the script.
 assert.deepEqual(script.explainability.analyst,{candidates_found:analysis.moments.length,selected_by_analyst:3,selected_by_script:analysis.moments.length});
 assert.equal(script.explainability.interesting_findings.length,3);
 assert.ok(script.explainability.summary.includes(String(profile.films.length)));
 assert.equal(script.generation_meta.analyst.model,'analyst-model');
 assert.equal(script.generation_meta.writer.status,'complete');
 // Nothing private travels to the browser: no key, no prompt, no raw export.
 const serialized=JSON.stringify(script);
 for(const secret of ['api_key','API_KEY','AIza','prompt','raw_export'])assert.equal(serialized.includes(secret),false,secret);
});

test('the Writer receives bounded style examples and never the key',async t=>{
 const {profile,analysis}=await readExport(),ids=analysis.moments.map(moment=>moment.id);
 let body='';
 t.mock.method(globalThis,'fetch',async(url,options)=>{body=String(options?.body||'');return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({greeting:'Certo.',archetype_phrase:'um titulo',profile_reaction:'uma reacao',closer:['fim'],profile_review:{lead:'Se eu falasse de você...',text:'uma review curta sobre comportamento'},reactions:ids.map(id=>({id,lines:['uma linha']}))})}]}}]});});
 const writing=await writeJudgment({profile,analysis,locale:'pt-BR',env:{GEMINI_API_KEY:'test-key-must-not-leak',GEMINI_MODEL:'test-model',__TEST_SKIP_ANALYST:'1'}});
 assert.equal(writing._degraded,false);
 assert.equal(body.includes('profile_review_style'),true);
 assert.equal(body.includes('profile_review_style_examples'),true);
 assert.equal(body.includes('median_length'),true);
 const request=JSON.parse(body),prompt=request.contents[0].parts[0].text,data=JSON.parse(prompt.slice(prompt.indexOf('DATA:\n')+6));
 assert.ok(data.profile_review_style_examples.length>=1&&data.profile_review_style_examples.length<=5);
 assert.ok(data.profile_review_style_examples.every(example=>example.text.length<=500));
 assert.ok(data.profile_review_style_examples.length<profile.reviews.length||profile.reviews.length<=5);
 assert.equal(body.includes('test-key-must-not-leak'),false);
 assert.equal(body.includes('GEMINI'),false);
});

test('a thin Analyst still delivers a session instead of an error screen',async t=>{
 const {profile,analysis}=await readExport(),ids=analysis.moments.slice(0,3).map(moment=>moment.id);
 // A real account can produce three excellent findings and twenty mediocre ones: that is a
 // shorter session, never analyst_unavailable.
 const semantics=profile.topFour.map(film=>({film_key:film.film_key,ingredients:['arquetipo','ambiente']}));
 const reaction={selected:ids.map(id=>({id,type:'stat',observation:`observacao ${id}`,why_interesting:'motivo',interestingness:.9,confidence:.9})),interaction_candidates:[],top_four_semantics:semantics};
 const writing={greeting:'Oi.',archetype_phrase:'um robo fugindo com caubois',profile_reaction:'',closer:['E isso ai.'],
  opening:{greeting:['Oi.'],archetype_lead:'Ja entendi.',archetype_phrase:'um robo fugindo com caubois',archetype_after:['Especifico demais.'],username_line:'Vou ficar com critic.',
   taste_bit:{enabled:true,lead:'Essas escolhas sao',strike:'duvidosas',correction:'corajosas',tail:'para dizer o minimo.'},judge_claim:'Eu julgo daqui.',transition:['Vamos investigar.']},
  profile_review:{full:'O perfil mediu poucas coisas e ainda assim contradiz a propria nota e as reassistidas.',share:'Poucas medidas, muita conviccao.',evidence_ids:ids.slice(0,2)},
  reactions:ids.map(id=>({id,lines:[`O dado de ${id} contradiz a propria nota.`]}))};
 let analystCalls=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const prompt=JSON.parse(options.body).contents[0].parts[0].text;
  if(prompt.includes('ROTEIRO INTEIRO'))return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(writing)}]}}]});
  analystCalls++;
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(reaction)}]}}]});
 });
 const result=await judge({__TEST_SKIP_ANALYST:false,GEMINI_ANALYST_MODEL:'analyst-only'});
 assert.equal(result.status,200);
 const script=await result.json();
 assert.equal(script.generation_meta.analyst.status,'thin');
 assert.equal(script.render.ai_generation,'complete');
 assert.equal(script.beats.length,3);
 assert.equal(script.ai.warnings.length,0);
 // The thin path still repairs once, asking for more material instead of failing.
 assert.equal(analystCalls,2);
});

