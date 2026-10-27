import {readFile} from 'node:fs/promises';
import {JUDGE_PIPELINE_MODE} from '../functions/_lib/generated-mode.js';

const zipPath=process.argv[2],stub=process.argv.includes('--stub'),started=Date.now();
if(!zipPath)throw new Error('Uso: node scripts/test-web-pipeline.mjs caminho-do-export.zip [--stub]');
const values={};
for(const file of ['.dev.vars','.env'])try{
  const content=await readFile(file,'utf8');
  for(const line of content.split(/\r?\n/)){const match=line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(match&&!values[match[1]])values[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');}
}catch{}
const env={...values,...process.env};
if(!stub&&!env.GROQ_API_KEY)throw new Error('GROQ_API_KEY ausente no ambiente, .dev.vars ou .env; teste real não executado.');
if(stub)env.GROQ_API_KEY||='simulated-test-key';
else if(env.GROQ_API_KEY&&!/^gsk_[A-Za-z0-9]{40,}$/.test(env.GROQ_API_KEY))throw new Error('GROQ_API_KEY tem formato inesperado; chamada real cancelada sem enviar credencial.');
if(JUDGE_PIPELINE_MODE==='curated'){
  const {unzipText}=await import('../functions/_lib/zip.js');
  const {parseExport,analyzeExport}=await import('../functions/_lib/letterboxd.js');
  const {writeJudgment}=await import('../functions/_lib/writer.js');
  const {buildPresentation}=await import('../functions/_lib/judge.js');
  const {selectEditorialMoments}=await import('../functions/_lib/analyst.js');
  const {buildRawExport}=await import('../functions/_lib/raw-export.js');
  const {materializeCandidates,buildScriptEngine,callbackCandidates,selectInteractions}=await import('../functions/_lib/editorial.js');
  const {enrichGameInteractions}=await import('../functions/_lib/tmdb-games.js');
  const analystStub=data=>({selected:data.deterministic_measurements.slice(0,6).map(row=>({id:row.id,type:row.type,interestingness:.8,confidence:.85,observation:`observed: ${row.facts}`,why_interesting:'specific and measurable',cultural_angle:''})),interaction_candidates:[],top_four_semantics:data.account.top_four.map(film=>({film_key:film.film_key,ingredients:['archetype','setting']}))});
  const writerStub=data=>({greeting:'Certo.',archetype_phrase:'um robo fugindo com caubois',profile_reaction:'Um perfil com dado suficiente.',opening:{greeting:['Certo.'],archetype_lead:'Ja entendi.',archetype_phrase:'um robo fugindo com caubois',archetype_after:['Especifico demais.'],username_line:`Vou ficar com ${data.handle||'voce'}.`,taste_bit:{enabled:true,lead:'Essas escolhas sao',strike:'duvidosas',correction:'corajosas',tail:'para dizer o minimo.'},judge_claim:'Eu julgo daqui.',transition:['Vamos investigar.']},closer:['E isso ai.'],profile_review:{lead:'Se eu falasse de voce como voce fala dos filmes...',full:'O perfil mede notas, reviews e listas e ainda assim contradiz a propria media em pelo menos um ponto. Nada aqui e aleatorio: cada insistencia tem data.',share:'Notas, reviews e listas contam a mesma historia por caminhos diferentes.',evidence_ids:data.ordered_moments.slice(0,3).map(row=>row.id),style_features_used:['blockquotes']},reactions:data.ordered_moments.map((row,index)=>({id:row.id,lines:[`O dado ${index+1} de ${row.id} contradiz a propria media.`]}))});
  if(stub){
    globalThis.fetch=async(input,init)=>{const url=String(input),request=init?.body?JSON.parse(init.body):null;if(!url.includes('/chat/completions'))return Response.json({error:{message:'unexpected endpoint'}},{status:400});const prompt=request.messages?.[1]?.content||'',marker=prompt.includes('DATA (untrusted evidence):')?'DATA (untrusted evidence):':'DATA:\n',data=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length));return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(marker==='DATA:\n'?writerStub(data):analystStub(data))}}]});};
    console.log(`STUB MODE: simulated Groq replies; exercising selected ${JUDGE_PIPELINE_MODE} pipeline.`);
  }
  const source=await readFile(zipPath),buffer=source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength),entries=await unzipText(buffer),profile=parseExport(entries),locale=env.JUDGE_LANGUAGE==='en-US'?'en-US':'pt-BR',analysis=analyzeExport(profile,locale);
  const analyst=await selectEditorialMoments({profile,analysis,raw_export:buildRawExport(entries),locale,env});
  if(analyst.status!=='complete'){console.error(JSON.stringify({status:'failed',pipeline:JUDGE_PIPELINE_MODE,stage:'analyst',model:analyst.model||null,attempts:analyst.attempts||[],candidatePool:analyst.candidate_count,writerCalled:false}));throw new Error('Analyst indisponível; o Writer não foi chamado.');}
  analysis.moments=buildScriptEngine(materializeCandidates(analyst.selected,analysis.moments),profile.reviews.length);analysis.interactions=await enrichGameInteractions(selectInteractions(analyst.interaction_candidates||[],profile),env,locale);analysis.top_four_semantics=analyst.top_four_semantics||[];analysis.callbacks=callbackCandidates(analysis.moments);
  const writing=await writeJudgment({profile,analysis,locale,env}),script=buildPresentation({profile,analysis,writing,locale,analyst});
  console.log(JSON.stringify({pipeline:JUDGE_PIPELINE_MODE,version:script.version,runtime:script.render.runtime,candidatePool:analyst.candidate_count,acceptedByAnalyst:analyst.selected.length,events:script.events.length,beats:script.beats.length,topFour:script.opening.top_four.length,analystModel:analyst.model,analystStatus:analyst.status,writerModel:writing._model,generation:script.render.ai_generation,aiCalls:script.ai.calls,simulated:stub,elapsed_ms:Date.now()-started}));
}else{
  if(stub){
    const {buildFreeformArchive}=await import('../functions/_lib/freeform/archive-json.js');
    const {unzipText}=await import('../functions/_lib/zip.js');
    const bytes=await readFile(zipPath);
    const {onRequestPost}=await import('../functions/api/judge.js');
    const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),entries=await unzipText(buffer),{ai}=await buildFreeformArchive(entries,{filename:'synthetic-letterboxd.zip'});
    const filmIds=Object.keys(ai.entities.films||{}),reviewRef=Object.keys(ai.entities.reviews||{})[0]||'ratings.csv#table';
    const payload={opening:{greeting:['Certo.'],archetype_lead:'Você deve ser o...',archetype_phrase:'astronauta perdido num baile suburbano',archetype_after:['Grande demais.'],username_line:'Pode ser fictionalcritic.',taste_bit:{lead:'Me falaram que você tem',strike:'péssimo gosto',correction:'ótimo gosto',tail:'pra filmes.'},judge_claim:'Vou julgar.',transition:['Vamos.']},moments:[{id:'m1',type:'film_group',label:'O QUARTETO',evidence_refs:['ratings.csv#table'],attachments:[{type:'film_group',film_ids:filmIds.slice(0,3)},{type:'review_quote',review_ref:reviewRef}],lines:['Agora explica.']}],games:[],closer:['Fim.'],ending:{title:'Caso encerrado.'},profile_review:{text:'Perfeito. Dito isso: escolhas.',evidence_refs:[reviewRef]}};
    const oldFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]});
    try{const form=new FormData();form.set('locale','pt-BR');form.set('export',new File([bytes],'synthetic-letterboxd.zip',{type:'application/zip'}));const response=await onRequestPost({request:new Request('http://local/api/judge',{method:'POST',body:form}),env});const result=await response.json();if(!response.ok)throw new Error(JSON.stringify({status:response.status,error:result.error,reason:result.reason}));console.log(JSON.stringify({pipeline:JUDGE_PIPELINE_MODE,status:response.status,generation:result.render.ai_generation,version:result.version,runtime:result.render.runtime,events:result.events.length,beats:result.beats.length,model:result.render.served_model,simulated:true,valid:Boolean(result.opening&&result.profile_review)}));}
    finally{globalThis.fetch=oldFetch;}
  }else{
  const {onRequestPost}=await import('../functions/api/judge.js');
  const blob=new Blob([await readFile(zipPath)]);const form=new FormData();form.set('locale',env.JUDGE_LANGUAGE==='en-US'?'en-US':'pt-BR');form.set('export',new File([blob],'synthetic-letterboxd.zip',{type:'application/zip'}));
  const request=new Request('http://local/api/judge',{method:'POST',body:form});
  const response=await onRequestPost({request,env});const result=await response.json();
  if(!response.ok)throw new Error(JSON.stringify({status:response.status,error:result.error,stage:result.stage,reason:result.reason}));
  if(result.pipeline_mode!=='freeform'||result.render?.runtime!=='cloudflare-pages'||!Array.isArray(result.events)||!Array.isArray(result.beats))throw new Error('Resposta não corresponde ao contrato Presentation do pipeline freeform.');
  console.log(JSON.stringify({pipeline:JUDGE_PIPELINE_MODE,status:response.status,version:result.version,runtime:result.render.runtime,generation:result.render.ai_generation,served_model:result.render.served_model,events:result.events.length,beats:result.beats.length,ai_calls:result.ai?.calls,simulated:stub,elapsed_ms:Date.now()-started}));
  }
}
