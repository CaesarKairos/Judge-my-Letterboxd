import {test} from 'node:test';
import assert from 'node:assert/strict';
import {unzipText} from '../functions/_lib/zip.js';
import {parseExport,analyzeExport} from '../functions/_lib/letterboxd.js';
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
 'reviews.csv':'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n2026-01-01,Alpha,2000,https://boxd.it/a,1,,"Dito isso: ruim.",,2026-01-01\n2026-02-01,Beta,2001,https://boxd.it/b,5,,"Dito isso: perfeito.",,2026-02-01\n',
 'lists/favorites.csv':'Letterboxd list export v7\nDate,Name,Tags,URL,Description\n2026-01-01,My list,,https://boxd.it/list,Description\n\nPosition,Name,Year,URL,Description\n1,Beta,2001,https://boxd.it/b,\n'
};

test('ZIP parser and independent web analyzer read an official export shape',async()=>{
 const files=await unzipText(storedZip(fixture).buffer),profile=parseExport(files),analysis=analyzeExport(profile,'pt-BR');
 assert.equal(profile.handle,'critic');assert.equal(profile.topFour.length,4);assert.equal(profile.reviews.length,2);
 assert.ok(analysis.moments.some(row=>row.type==='film_pair'));assert.ok(analysis.moments.some(row=>row.type==='rewatch'));assert.ok(analysis.moments.some(row=>row.type==='phrase'));
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
