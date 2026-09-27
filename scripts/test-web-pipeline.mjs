import {readFile} from 'node:fs/promises';
import {unzipText} from '../functions/_lib/zip.js';
import {parseExport,analyzeExport} from '../functions/_lib/letterboxd.js';
import {writeJudgment} from '../functions/_lib/gemini.js';
import {buildPresentation} from '../functions/_lib/judge.js';

const zipPath=process.argv[2];
if(!zipPath)throw new Error('Uso: node scripts/test-web-pipeline.mjs caminho-do-export.zip');
const envText=await readFile('.env','utf8');
const env=Object.fromEntries(envText.split(/\r?\n/).map(line=>line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(match=>[match[1],match[2].replace(/^['"]|['"]$/g,'')]));
if(!env.GEMINI_API_KEY)throw new Error('GEMINI_API_KEY ausente no .env local');
const source=await readFile(zipPath),buffer=source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength);
const profile=parseExport(await unzipText(buffer)),analysis=analyzeExport(profile,env.JUDGE_LANGUAGE==='en-US'?'en-US':'pt-BR');
const locale=env.JUDGE_LANGUAGE==='en-US'?'en-US':'pt-BR';
const writing=await writeJudgment({profile,analysis,locale,env});
const script=buildPresentation({profile,analysis,writing,locale});
console.log(JSON.stringify({version:script.version,runtime:script.render.runtime,events:script.events.length,beats:script.beats.length,topFour:script.opening.top_four.length,aiCalls:script.ai.calls}));
