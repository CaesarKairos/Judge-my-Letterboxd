// Dev-only harness: runs the real Freeform Judge against a real export and prints the whole
// contract conversation (request size, HTTP, finishReason, response size, and the per-response
// validation: opening, moments, attachments, games, profile review, why each item failed). It also
// reports the mechanical normalization (entity ids → archive refs) and the targeted repairs.
// Local runs only; never prints a key, a review or any private cell. Uso:
//   node scripts/freeform-diagnostic.mjs caminho-do-export.zip
import {readFile} from 'node:fs/promises';
import {unzip} from '../functions/_lib/zip.js';
import {salvageJson} from '../functions/_lib/json-repair.js';
import {buildFreeformArchive} from '../functions/_lib/freeform/archive-json.js';
import {buildFreeformRegistry,normalizeFreeformReferences} from '../functions/_lib/freeform/references.js';
import {validateFreeformResponse} from '../functions/_lib/freeform/validator.js';
import {freeformJudge} from '../functions/_lib/freeform/judge.js';
import {discoverTextModels,mergeModels} from '../functions/_lib/models.js';

process.loadEnvFile('.env');
const pick=name=>(process.env[name]||'').trim();
const env={GEMINI_API_KEY:pick('GEMINI_API_KEY'),GEMINI_MODEL:pick('GEMINI_MODEL'),GEMINI_FALLBACK_MODELS:pick('GEMINI_FALLBACK_MODELS'),
  GEMINI_FREEFORM_MODEL:pick('GEMINI_FREEFORM_MODEL'),GEMINI_FREEFORM_FALLBACK_MODELS:pick('GEMINI_FREEFORM_FALLBACK_MODELS'),
  GEMINI_WRITER_MODEL:pick('GEMINI_WRITER_MODEL'),GEMINI_WRITER_FALLBACK_MODELS:pick('GEMINI_WRITER_FALLBACK_MODELS'),
  GEMINI_MODEL_DISCOVERY:pick('GEMINI_MODEL_DISCOVERY')};
const zipPath=process.argv[2];
if(!zipPath)throw new Error('Uso: node scripts/freeform-diagnostic.mjs caminho-do-export.zip');

const started=Date.now(),zip=await readFile(zipPath);
const entries=await unzip(zip.buffer.slice(zip.byteOffset,zip.byteOffset+zip.byteLength),{maxEntries:500,maxExpanded:256*1024*1024});
const {ai,diagnostics}=await buildFreeformArchive(entries,{filename:zipPath.split(/[\\/]/).pop()});
const registry=buildFreeformRegistry(ai);
console.log('Archive (AI):',diagnostics.archive_ai_chars,'chars | lossless:',diagnostics.archive_lossless_chars,'chars | files:',diagnostics.files,'rows:',diagnostics.rows);
console.log('Entity counts:',JSON.stringify(registry.size));

const configured=[env.GEMINI_FREEFORM_MODEL||env.GEMINI_WRITER_MODEL||env.GEMINI_MODEL||'gemini-flash-latest',
  ...String(env.GEMINI_FREEFORM_FALLBACK_MODELS||env.GEMINI_WRITER_FALLBACK_MODELS||env.GEMINI_FALLBACK_MODELS||'').split(',').map(value=>value.trim()).filter(Boolean)];
const discovered=await discoverTextModels(env),models=mergeModels(configured,discovered);
console.log('Model chain ('+models.length+'):',models.join(' -> ')||'(none)');
console.log('Discovery:',discovered.length?`ok, ${discovered.length} textual models`:'unavailable','| key present',Boolean(env.GEMINI_API_KEY));

// Every call is intercepted so the stage can be audited from the log alone. Editorial answers are
// re-validated here offline to expose the per-response contract result the judge hides internally.
const traffic=[],original=globalThis.fetch;
globalThis.fetch=async(input,init={})=>{
  const url=typeof input==='string'?input:String(input?.url||''),raw=typeof init?.body==='string'?init.body:'';
  const request=raw?JSON.parse(raw):{},systemText=request?.system_instruction?.parts?.[0]?.text||'';
  const kind=/repair JSON references/.test(systemText)?'repair':(request?.generationConfig?.responseSchema?'editorial':'other');
  const entry={kind,request_chars:raw.length,schema:Boolean(request?.generationConfig?.responseSchema),started:Date.now()};
  traffic.push(entry);
  const response=await original(input,init);
  entry.status=response.status;entry.ms=Date.now()-entry.started;
  if(url.includes(':generateContent')){
    const clone=response.clone();
    if(!response.ok){
      try{const body=await clone.json();entry.provider_error={code:body?.error?.code??response.status,status:body?.error?.status||'',message:String(body?.error?.message||'').slice(0,160)};}
      catch{entry.provider_error={code:response.status,message:'unreadable error body'};}
    }else{
      try{
        const body=await clone.json(),candidate=body?.candidates?.[0],text=(candidate?.content?.parts||[]).map(part=>part.text||'').join('');
        entry.finishReason=candidate?.finishReason||null;entry.response_chars=text.length;entry.blocked=Boolean(body?.promptFeedback?.blockReason);
        if(kind==='editorial'){
          const parsed=salvageJson(text);
          if(!parsed){entry.summary={parse:'salvage_failed'};}
          else{
            const normalized=normalizeFreeformReferences(parsed,registry),validated=validateFreeformResponse(normalized.payload,ai,{registry});
            entry.summary=validated.validation_summary;entry.conversions=normalized.conversions.length;entry.status_guess=validated.generation_status;
            entry.reasons=validated.invalid.map(reason=>reason.kind==='attachment'?`invalid attachment (${reason.reason})`:reason.kind==='moment'?`invalid moment (${reason.reason})`:reason.kind==='game'?`invalid game (${reason.reason})`:reason.kind).slice(0,8);
          }
        }
      }catch(error){entry.body_error=String(error.message||error).slice(0,80);}
    }
  }
  console.log(' ·',entry.status??'-',entry.kind,entry.schema?'schema':'json',entry.finishReason||entry.provider_error?.code||entry.body_error||'',(entry.ms??'')+'ms');
  return response;
};

let result=null,failure=null;
try{result=await freeformJudge({archive:ai,locale:'pt-BR',env});}catch(caught){failure=caught;}

console.log('--- HTTP attempts ---');
for(const row of traffic)console.log(' ',row.status||'-',String(row.request_chars).padStart(8),'chars in |',String(row.response_chars??'-').padStart(7),'chars out |',row.finishReason||'-','|',row.kind,'|',row.schema?'schema':'json','|',row.ms+'ms');
console.log('--- Per-response validation ---');
for(const row of traffic.filter(item=>item.kind==='editorial')){
  if(row.provider_error){console.log(' HTTP',row.status,'provider_error',row.provider_error.code,row.provider_error.status,row.provider_error.message);continue;}
  if(!row.summary){console.log(' HTTP',row.status,row.body_error||row.finishReason||'-');continue;}
  const s=row.summary;
  if(s.parse){console.log(' HTTP',row.status,s.parse);continue;}
  console.log(' CORE CONTRACT | opening',s.opening?'valid':'invalid','| username_before_archetype',s.username_before_archetype?'yes':'no','| games required',s.required_games,'| games valid',s.games_valid,'| games missing',s.games_missing,'| profile review',s.profile_review?'valid':'invalid');
  console.log(' EDITORIAL | moments',`${s.moments_valid}/${s.moments_received}`,'| attachments',`${s.attachments_valid}/${s.attachments_valid+s.attachments_invalid}`);
  console.log(' FINAL DECISION |',row.status_guess);
  for(const reason of row.reasons||[])console.log('   -',reason);
  if(row.conversions)console.log('   entity refs converted:',row.conversions);
}
console.log('--- Repair calls ---');
for(const row of traffic.filter(item=>item.kind==='repair'))console.log(' ',row.status||'-','| finishReason',row.finishReason||'-','|',row.ms+'ms');
console.log('--- Freeform result ---');
if(failure){
  console.log(' AI_FAILED | stage',failure.details?.stage||'-','| reason',failure.details?.reason||failure.message);
  if(failure.details?.validation_summary)console.log(' best validation:',JSON.stringify(failure.details.validation_summary));
  for(const row of failure.details?.attempts||[])console.log('  ',JSON.stringify(row));
  console.log('Freeform status: FAILED');
}else{
  console.log(' model',result._model,'| finishReason',result._finish_reason,'| response chars',result._response_chars);
  const before=result._core_before_repair||{},after=result._core_after_repair||result.validation_summary||{};
  console.log(' CORE BEFORE REPAIR: opening',before.opening?'valid':'invalid','| problems',JSON.stringify(before.opening_problems||[]),'| games required',before.required_games??'-','| games valid',before.games_valid??'-','| games missing',before.games_missing??'-','| profile review',before.profile_review?'valid':'invalid','| ai-like',before.profile_review_ai_like?'yes':'no');
  console.log(' CORE REPAIRS:',JSON.stringify((result._repairs||[]).filter(name=>name==='opening'||name==='missing_games'||name==='profile_review')));
  console.log(' CORE AFTER REPAIR: opening',after.opening?'valid':'invalid','| problems',JSON.stringify(after.opening_problems||[]),'| games required',after.required_games??'-','| games valid',after.games_valid??'-','| games missing',after.games_missing??'-','| profile review',after.profile_review?'valid':'invalid','| ai-like',after.profile_review_ai_like?'yes':'no');
  console.log(' CORE CONTRACT | opening',result.opening_valid?'valid':'invalid','| username_before_archetype',result.validation_summary.username_before_archetype?'yes':'no','| archetype',result.opening?.archetype_phrase||'-','| games required',result.required_games,'| games valid',result.games.length,'| profile review',result.profile_review_valid?'valid':'invalid');
  console.log(' EDITORIAL | moments',result.moments.length);
  console.log(' FINAL DECISION |',result.generation_status);
  console.log(' FINAL: core_contract_complete',result.core_contract_complete,'| generation_status',result.generation_status,'| model',result._model);
  console.log(' refs converted',(result._conversions||[]).length,'| repairs',JSON.stringify(result._repairs||[]));
  console.log('Freeform status:',String(result.generation_status||'complete').toUpperCase());
}
console.log('elapsed ms',Date.now()-started);
