import {test} from 'node:test';
import assert from 'node:assert/strict';
import {unzipText} from '../functions/_lib/zip.js';
import {parseExport,analyzeExport} from '../functions/_lib/letterboxd.js';
import {buildPresentation} from '../functions/_lib/judge.js';
import {salvageJson,normalizeJudgment} from '../functions/_lib/gemini.js';

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

test('Pages Function falls back across models and returns Presentation without Python',async t=>{
 const writing={greeting:'Certo.',archetype_phrase:'quatro décadas e nenhum consenso',profile_reaction:'Quatro filmes e duas reviews. Corajoso.',reactions:[
  {id:'phrase',lines:['Você até criou uma cláusula de encerramento.']},{id:'rating-contrast',lines:['Um ponto para Alpha. Cinco para Beta.']},{id:'rewatch',lines:['Beta outra vez. Naturalmente.']},{id:'tag',lines:['Comfort, porque terapia tem fila.']},{id:'list',lines:['Uma lista com convicção.']},{id:'quote-review-1',lines:['Breve e cruel.']},{id:'quote-review-2',lines:['Cinco estrelas e ponto final.']}
 ]};
 let calls=0;t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;assert.match(String(url),/generativelanguage\.googleapis\.com/);assert.equal(options.headers['x-goog-api-key'],'secret');if(calls<3)return Response.json({error:{message:'busy'}},{status:503});return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(writing)}]}}]});});
 const form=new FormData();form.set('locale','pt-BR');form.set('export',new File([storedZip(fixture)],'letterboxd.zip',{type:'application/zip'}));
 const result=await onRequestPost({request:new Request('https://example.com/api/judge',{method:'POST',body:form}),env:{GEMINI_API_KEY:'secret',GEMINI_MODEL:'test-model'}});
 assert.equal(result.status,200);const script=await result.json();assert.equal(script.version,'presentation-v1');assert.equal(script.render.runtime,'cloudflare-pages');assert.equal(script.render.served_model,'gemini-2.5-flash');assert.equal(script.ai.calls,3);assert.equal(script.opening.top_four.length,4);assert.ok(script.events.some(event=>event.cue==='top_four_reveal'));assert.ok(script.events.some(event=>event.type==='film_pair'));
});

test('Pages Function reports missing secret and malformed exports clearly',async()=>{
 let form=new FormData();form.set('export',new File([storedZip(fixture)],'letterboxd.zip'));
 let result=await onRequestPost({request:new Request('https://example.com/api/judge',{method:'POST',body:form}),env:{}});assert.equal(result.status,503);assert.equal((await result.json()).error,'missing_gemini_key');
 form=new FormData();form.set('export',new File([storedZip({'other.csv':'A\nB\n'})],'letterboxd.zip'));
 result=await onRequestPost({request:new Request('https://example.com/api/judge',{method:'POST',body:form}),env:{GEMINI_API_KEY:'x'}});assert.equal(result.status,422);
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

const judge=extra=>{const form=new FormData();form.set('locale','pt-BR');form.set('export',new File([storedZip(fixture)],'letterboxd.zip',{type:'application/zip'}));return onRequestPost({request:new Request('https://example.com/api/judge',{method:'POST',body:form}),env:{GEMINI_API_KEY:'secret',...extra}});};
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
 assert.deepEqual(script.beats[0].lines.map(line=>line.text),['Primeira linha.','Segunda']);
 assert.equal(script.beats[0].event_count>0,true);
});

test('an unusable model answer degrades to a partial script instead of an error screen',async t=>{
 const {analysis}=await readExport();
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{"greeting":"Oi'}]}}]});});
 const result=await judge();assert.equal(result.status,200);
 const script=await result.json();
 assert.ok(calls>=4);assert.equal(script.render.quality_degraded,true);assert.equal(script.render.ai_generation,'partial');
 assert.ok(script.ai.warnings.some(warning=>warning.includes('missing reactions')));
 assert.equal(script.opening.salutation,'Oi');
 assert.equal(script.beats.length,analysis.moments.length);
 assert.equal(script.beats.every(beat=>beat.status==='silent'&&beat.render_strategy==='silence'),true);
 // Evidence, stats and the opening are deterministic, so the judgment still happens.
 assert.equal(script.events.some(event=>event.type==='profile_stats'),true);
 assert.equal(script.events.filter(event=>event.type==='typing').length>0,true);
});

test('an unreadable model answer still reports a clear model error',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'desculpe, mas nao vou responder em JSON'}]}}]}));
 const result=await judge();assert.equal(result.status,502);assert.equal((await result.json()).error,'gemini_invalid_response');
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
 assert.deepEqual(ok.reactions.find(row=>row.id==='a'),{id:'a',lines:['uma linha'],evidence_pause:'medium',after_evidence:'long',typing:'short',between_lines:'medium',after_reaction:'medium'});
 assert.equal(ok.reactions.find(row=>row.id==='b').evidence_pause,'long');assert.equal(ok.reactions.find(row=>row.id==='b').typing,'short');
 const bad=normalizeJudgment({greeting:'',archetype_phrase:'x',profile_reaction:'y',reactions:[{id:'a',lines:['x']},{id:'extra',lines:['x']},{id:'a'}]},ids);
 assert.equal(bad.ok,false);assert.deepEqual(bad.missing,['b']);
 assert.equal(bad.problems.some(problem=>problem.includes('unknown evidence id')),true);
 assert.equal(bad.problems.some(problem=>problem.includes('greeting is empty')),true);
 assert.equal(normalizeJudgment(null,ids).ok,false);assert.equal(normalizeJudgment('nope',ids).ok,false);
});

