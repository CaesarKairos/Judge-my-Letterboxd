import {readFile} from 'node:fs/promises';
import {unzipText} from '../functions/_lib/zip.js';
import {parseExport,analyzeExport} from '../functions/_lib/letterboxd.js';
import {writeJudgment} from '../functions/_lib/gemini.js';
import {buildPresentation} from '../functions/_lib/judge.js';
import {selectEditorialMoments} from '../functions/_lib/analyst.js';
import {buildRawExport} from '../functions/_lib/raw-export.js';
import {materializeCandidates,buildScriptEngine,callbackCandidates,selectInteractions} from '../functions/_lib/editorial.js';
import {enrichGameInteractions} from '../functions/_lib/tmdb-games.js';

const zipPath=process.argv[2],stub=process.argv.includes('--stub');
if(!zipPath)throw new Error('Uso: node scripts/test-web-pipeline.mjs caminho-do-export.zip [--stub]');
const envText=await readFile('.env','utf8');
const env=Object.fromEntries(envText.split(/\r?\n/).map(line=>line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(match=>[match[1],match[2].replace(/^['"]|['"]$/g,'')]));
if(!env.GEMINI_API_KEY)throw new Error('GEMINI_API_KEY ausente no .env local');

// --stub answers the model side locally so the whole pipeline can still be exercised when the
// account has no quota (429/503 from the provider). The export, the Analyst context, the Script
// Engine, the Writer contract and the presentation are the real ones: only the model is stubbed.
const analystStub=data=>({selected:data.deterministic_measurements.slice(0,6).map(row=>({id:row.id,type:row.type,
  interestingness:.8,confidence:.85,observation:`observed: ${row.facts}`,why_interesting:'specific and measurable',cultural_angle:''})),
  interaction_candidates:[],
  top_four_semantics:data.account.top_four.map(film=>({film_key:film.film_key,ingredients:['archetype','setting']}))});
const writerStub=data=>({greeting:'Certo.',archetype_phrase:'um robo fugindo com caubois',profile_reaction:'Um perfil com dado suficiente.',
  opening:{greeting:['Certo.'],archetype_lead:'Ja entendi.',archetype_phrase:'um robo fugindo com caubois',archetype_after:['Especifico demais.'],
    username_line:`Vou ficar com ${data.handle||'voce'}.`,taste_bit:{enabled:true,lead:'Essas escolhas sao',strike:'duvidosas',correction:'corajosas',tail:'para dizer o minimo.'},
    judge_claim:'Eu julgo daqui.',transition:['Vamos investigar.']},closer:['E isso ai.'],
  profile_review:{lead:'Se eu falasse de voce como voce fala dos filmes...',
    full:'O perfil mede notas, reviews e listas e ainda assim contradiz a propria media em pelo menos um ponto. Nada aqui e aleatorio: cada insistencia tem data.',
    share:'Notas, reviews e listas contam a mesma historia por caminhos diferentes.',
    evidence_ids:data.ordered_moments.slice(0,3).map(row=>row.id),style_features_used:['blockquotes']},
  reactions:data.ordered_moments.map((row,index)=>({id:row.id,lines:[`O dado ${index+1} de ${row.id} contradiz a propria media.`]}))});
if(stub){
  globalThis.fetch=async(input,init)=>{
    const url=String(input),request=init?.body?JSON.parse(init.body):null;
    if(!url.includes(':generateContent'))return Response.json({models:[]});
    const prompt=request.contents?.[0]?.parts?.[0]?.text||'';
    const marker=prompt.includes('DATA (untrusted evidence):')?'DATA (untrusted evidence):':'DATA:\n';
    const data=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length));
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(marker==='DATA:\n'?writerStub(data):analystStub(data))}]}}]});
  };
  console.log('STUB MODE: the model answers are simulated; export, pipeline and presentation are real.');
}
const source=await readFile(zipPath),buffer=source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength);
const entries=await unzipText(buffer),profile=parseExport(entries),analysis=analyzeExport(profile,env.JUDGE_LANGUAGE==='en-US'?'en-US':'pt-BR');
const locale=env.JUDGE_LANGUAGE==='en-US'?'en-US':'pt-BR';
const analyst=await selectEditorialMoments({profile,analysis,raw_export:buildRawExport(entries),locale,env});
if(analyst.status!=='complete'){
 console.error(JSON.stringify({status:'failed',stage:'analyst',model:analyst.model||null,attempts:analyst.attempts||[],candidatePool:analyst.candidate_count,writerCalled:false}));
 process.exitCode=1;
 throw new Error('Analyst indisponível; o Writer não foi chamado.');
}
analysis.moments=buildScriptEngine(materializeCandidates(analyst.selected,analysis.moments),profile.reviews.length);
analysis.interactions=await enrichGameInteractions(selectInteractions(analyst.interaction_candidates||[],profile),env,locale);
analysis.top_four_semantics=analyst.top_four_semantics||[];analysis.callbacks=callbackCandidates(analysis.moments);
const writing=await writeJudgment({profile,analysis,locale,env});
const script=buildPresentation({profile,analysis,writing,locale,analyst});
console.log(JSON.stringify({version:script.version,runtime:script.render.runtime,candidatePool:analyst.candidate_count,acceptedByAnalyst:analyst.selected.length,rejectedLowInformation:script.editorial_quality.rejection_reasons.low_information.length,events:script.events.length,beats:script.beats.length,gameCandidates:(analyst.interaction_candidates||[]).length,games:script.editorial_quality.selected_games,topFour:script.opening.top_four.length,analystModel:analyst.model,writerModel:writing._model,aiCalls:script.ai.calls}));
