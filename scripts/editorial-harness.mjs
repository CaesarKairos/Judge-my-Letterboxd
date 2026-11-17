import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {onRequestPost} from '../functions/api/judge.js';

const root=path.resolve(import.meta.dirname,'..');
const source=process.argv[2];
const label=(process.argv[3]||'run').replace(/[^a-z0-9_-]+/gi,'-').slice(0,50);
if(!source)throw new Error('Uso: npm run evaluate:editorial -- <export.zip> [rotulo]');

const parseEnv=text=>Object.fromEntries(text.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#')).map(line=>{const at=line.indexOf('=');if(at<1)return null;let value=line.slice(at+1).trim();if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);return [line.slice(0,at).trim(),value];}).filter(Boolean));
let local={};try{local=parseEnv(await fs.readFile(path.join(root,'.env'),'utf8'));}catch{}
const key=process.env.GEMINI_API_KEY||local.GEMINI_API_KEY||local.NEW_GEMINI_API_KEY;
if(!key)throw new Error('GEMINI_API_KEY não encontrada no ambiente ou .env');

const stamp=new Date().toISOString().replace(/[:.]/g,'-'),dir=path.join(root,'.editorial-runs',`${stamp}-${label}`);
await fs.mkdir(dir,{recursive:true});
const captures=[];
const env={...local,...process.env,GEMINI_API_KEY:key,__TEST_PIPELINE_MODE:'freeform',__EDITORIAL_HARNESS:entry=>{captures.push(entry);}};
const bytes=await fs.readFile(path.resolve(source)),form=new FormData();
form.set('locale','pt-BR');form.set('export',new File([bytes],path.basename(source),{type:'application/zip'}));
const started=Date.now(),response=await onRequestPost({request:new Request('https://editorial.local/api/judge',{method:'POST',body:form}),env}),body=await response.json(),duration_ms=Date.now()-started;
const promptFiles=['prompts/freeform-judge.txt','prompts/judge-voice.txt'];
const prompt_hashes={};for(const file of promptFiles){const data=await fs.readFile(path.join(root,file));prompt_hashes[file]=crypto.createHash('sha256').update(data).digest('hex');}
const raw=captures.filter(row=>row.stage==='model_reply'),validated=captures.filter(row=>row.stage==='validated');
const polished=captures.filter(row=>row.stage==='polished_reply');
const metadata={created_at:new Date().toISOString(),label,source_filename:path.basename(source),source_bytes:bytes.length,http_status:response.status,duration_ms,prompt_hashes,models:[...new Set(raw.map(row=>row.model))],calls:raw.map(({model,finish_reason,usage,attempts})=>({model,finish_reason,usage,attempts}))};
await fs.writeFile(path.join(dir,'metadata.json'),JSON.stringify(metadata,null,2));
await fs.writeFile(path.join(dir,'raw-ai.json'),JSON.stringify(raw,null,2));
await fs.writeFile(path.join(dir,'polished-ai.json'),JSON.stringify(polished,null,2));
await fs.writeFile(path.join(dir,'validated.json'),JSON.stringify(validated,null,2));
await fs.writeFile(path.join(dir,'presentation.json'),JSON.stringify(body,null,2));
await fs.writeFile(path.join(dir,'transcript.md'),transcript(body));
await fs.writeFile(path.join(dir,'evaluation.md'),evaluationTemplate(metadata,body));
console.log(JSON.stringify({artifact_dir:dir,http_status:response.status,duration_ms,events:body.events?.length||0,beats:body.beats?.length||0},null,2));
if(!response.ok)process.exitCode=1;

function text(value){if(typeof value==='string')return value;return (value?.segments||value?.runs||[]).map(run=>run.text||run.title||'').join('');}
function films(event){return (event.films||[event.film].filter(Boolean)).map(f=>`${f.title}${f.year?` (${f.year})`:''}`).join(' · ');}
function transcript(result){
 const out=['# Transcrição editorial','',`Status HTTP: ${response.status}`,''];
 for(const event of result.events||[]){
  if(event.type==='message')out.push(text(event));
  else if(event.type==='strike')out.push(`~~${event.text}~~`);
  else if(event.type==='correction')out.push(`Correção: ${event.replacement}`);
  else if(event.type==='moment_label')out.push(`\n[MARCADOR: ${event.label}]`);
  else if(['film','film_pair','film_group','rewatch'].includes(event.type))out.push(`\n[VISUAL ${event.type}: ${films(event)}]`);
  else if(event.type==='review_quote')out.push(`\n[CITAÇÃO — ${event.title}: “${event.text}”]`);
  else if(event.type==='tag')out.push(`\n[TAG: ${event.tag}; ${films(event)}]`);
  else if(event.type==='list')out.push(`\n[LISTA: ${event.name}; ${films(event)}]`);
  else if(event.type==='phrase')out.push(`\n[DADO: ${event.phrase}]`);
  else if(event.type==='stat')out.push(`\n[ESTATÍSTICA: ${JSON.stringify(event.stats)}]`);
  else if(event.type==='profile_stats')out.push(`\n[PAINEL: ${event.stats.map(s=>`${s.label} ${s.value}`).join(' · ')}]`);
  else if(event.type==='game_intro')out.push(`\n## Jogo\n\n${text(event)}`);
  else if(event.type?.startsWith('game_')){const c=event.copy||{};out.push(`Regras: ${c.instructions||'(ausentes)'}`,`Filmes: ${films(event)}`);if(c.roles?.length)out.push(`Papéis: ${c.roles.map(r=>`${r.label} (${r.id})`).join(' · ')}`);}
 }
 if(result.profile_review)out.push('\n## Profile Review','',text(result.profile_review.text));
 if(result.ending?.title)out.push('\n## Encerramento','',result.ending.title);
 return `${out.join('\n\n')}\n`;
}
function evaluationTemplate(meta,result){return `# Avaliação editorial — ${meta.label}\n\n- Fluidez e ritmo: /10\n- Naturalidade da linguagem: /10\n- Precisão factual: /10\n- Integração das evidências: /10\n- Qualidade do arquétipo Top 4: /10\n- Coerência dos visuais: /10\n- Clareza e diversão dos jogos: /10\n- Qualidade do Profile Review: /10\n- Variedade estrutural: /10\n- Força do encerramento: /10\n\nMédia: /10\n\n## Problemas concretos\n\n## Decisões para a próxima rodada\n\nValidação: ${JSON.stringify(result.ai?.warnings||[])}\n`;}
