import {readFile} from 'node:fs/promises';
import {unzipText} from '../functions/_lib/zip.js';
import {parseExport,analyzeExport} from '../functions/_lib/letterboxd.js';
import {writeJudgment} from '../functions/_lib/gemini.js';
import {buildPresentation} from '../functions/_lib/judge.js';
import {selectEditorialMoments} from '../functions/_lib/analyst.js';
import {buildRawExport} from '../functions/_lib/raw-export.js';
import {materializeCandidates,buildScriptEngine,callbackCandidates,selectInteractions} from '../functions/_lib/editorial.js';
import {enrichGameInteractions} from '../functions/_lib/tmdb-games.js';

const zipPath=process.argv[2];
if(!zipPath)throw new Error('Uso: node scripts/test-web-pipeline.mjs caminho-do-export.zip');
const envText=await readFile('.env','utf8');
const env=Object.fromEntries(envText.split(/\r?\n/).map(line=>line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(match=>[match[1],match[2].replace(/^['"]|['"]$/g,'')]));
if(!env.GEMINI_API_KEY)throw new Error('GEMINI_API_KEY ausente no .env local');
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
