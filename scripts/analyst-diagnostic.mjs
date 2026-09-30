// Dev-only harness: runs the real Analyst against a real export and prints the whole
// network conversation (request size, status, finishReason, response size, JSON parse,
// selected/top_four counts, rejection reason). Local runs only; never prints the key.
// Uso: node scripts/analyst-diagnostic.mjs caminho-do-export.zip
import {readFile} from 'node:fs/promises';
import {unzipText} from '../functions/_lib/zip.js';
import {parseExport,analyzeExport} from '../functions/_lib/letterboxd.js';
import {buildRawExport} from '../functions/_lib/raw-export.js';
import {discoverTextModels,mergeModels} from '../functions/_lib/models.js';
import {selectEditorialMoments} from '../functions/_lib/analyst.js';

process.loadEnvFile('.env');
const pick=name=>(process.env[name]||'').trim();
const env={GEMINI_API_KEY:pick('GEMINI_API_KEY'),GEMINI_MODEL:pick('GEMINI_MODEL'),GEMINI_FALLBACK_MODELS:pick('GEMINI_FALLBACK_MODELS'),
  GEMINI_ANALYST_MODEL:pick('GEMINI_ANALYST_MODEL'),GEMINI_ANALYST_FALLBACK_MODELS:pick('GEMINI_ANALYST_FALLBACK_MODELS'),
  GEMINI_MODEL_DISCOVERY:pick('GEMINI_MODEL_DISCOVERY')};
const zipPath=process.argv[2];
if(!zipPath)throw new Error('Uso: node scripts/analyst-diagnostic.mjs caminho-do-export.zip');

// Every call is intercepted so the stage can be audited from the log alone.
const traffic=[],original=globalThis.fetch;
globalThis.fetch=async(input,init={})=>{
  const url=typeof input==='string'?input:String(input?.url||''),raw=typeof init?.body==='string'?init.body:'';
  const entry={url,request_chars:raw.length,started:Date.now()};
  traffic.push(entry);
  const response=await original(input,init);
  entry.status=response.status;entry.ms=Date.now()-entry.started;
  if(url.includes(':generateContent')){
    const clone=response.clone();
    if(!response.ok){
      // A non-2xx answer is not generation output: http + provider_error + detail + duration.
      // Parsing it as a reply used to print a misleading "parse_error" for 404/429/503.
      try{const body=await clone.json();entry.provider_error={code:body?.error?.code??response.status,status:body?.error?.status||'',message:String(body?.error?.message||'').slice(0,140)};}
      catch{entry.provider_error={code:response.status,status:'',message:'unreadable error body'};}
      entry.json='not_parsed (non-2xx)';
    }else{
      try{
        const body=await clone.json(),candidate=body?.candidates?.[0],text=(candidate?.content?.parts||[]).map(part=>part.text||'').join('');
        entry.finishReason=candidate?.finishReason||null;entry.response_chars=text.length;entry.blocked=Boolean(body?.promptFeedback?.blockReason);
        try{const parsed=JSON.parse(text);entry.json='valid';entry.keys=Object.keys(parsed);entry.counts={selected:parsed.selected?.length??null,interaction_candidates:parsed.interaction_candidates?.length??null,top_four_semantics:parsed.top_four_semantics?.length??null};}
        catch(error){entry.json=`parse_error: ${error.message.slice(0,60)}`;}
      }catch(error){entry.json=`body_error: ${error.message.slice(0,60)}`;}
    }
  }
  return response;
};

const started=Date.now(),zip=await readFile(zipPath);
const entries=await unzipText(zip.buffer.slice(zip.byteOffset,zip.byteOffset+zip.byteLength));
const profile=parseExport(entries),analysis=analyzeExport(profile,'pt-BR'),raw_export=buildRawExport(entries);
console.log('Export:',entries.size,'files | films',profile.films.length,'| reviews',profile.reviews.length,'| sessions',profile.sessions.length,'| lists',profile.lists.length,'| top4',profile.topFour.length,'| candidate pool',analysis.moments.length);
const configured=[env.GEMINI_ANALYST_MODEL||env.GEMINI_MODEL||'gemini-flash-latest',...String(env.GEMINI_ANALYST_FALLBACK_MODELS||env.GEMINI_FALLBACK_MODELS||'').split(',').map(value=>value.trim()).filter(Boolean)];
const discovered=await discoverTextModels(env);
console.log('Analyst model chain ('+mergeModels(configured,discovered).length+'):',mergeModels(configured,discovered).join(' -> ')||'(none)');
console.log('Discovery:',discovered.length?`ok, ${discovered.length} textual models`:'unavailable','| key present',Boolean(env.GEMINI_API_KEY));
if(discovered.length)console.log('Discovered:',discovered.join(', '));
const analyst=await selectEditorialMoments({profile,analysis,raw_export,locale:'pt-BR',env});
console.log('--- HTTP attempts ---');
for(const entry of traffic)console.log(' ',entry.status||'-',String(entry.request_chars).padStart(7),'chars in |',String(entry.response_chars??'-').padStart(6),'chars out |',entry.finishReason||'-','|',entry.json||(entry.provider_error?`provider_error ${entry.provider_error.code} ${entry.provider_error.status}`.trim():'-'),'|',entry.ms+'ms |',entry.url.split('/models/')[1]?.split(':')[0]||entry.url.split('?')[0]);
console.log('--- Analyst attempts ---');
for(const row of analyst.attempts||[])console.log(' ',JSON.stringify(row));
console.log('--- Analyst result ---');
console.log(JSON.stringify({status:analyst.status,reason:analyst.reason,model:analyst.model,chain:analyst.chain,context_chars:analyst.context_chars,request_chars:analyst.request_chars,
  editorial_strength:analyst.editorial_strength,strong_count:analyst.strong_count,strong_target:analyst.strong_target,selected:analyst.selected.length,
  interactions:(analyst.interaction_candidates||[]).length,top_four_semantics:(analyst.top_four_semantics||[]).length,top_four_expected:profile.topFour.length,
  top_four_semantics_status:analyst.top_four_semantics_status,missing_semantic_keys:analyst.missing_semantic_keys,truncated:analyst.truncated,salvaged:analyst.salvaged,
  repairs:analyst.repairs,unavailable_models:analyst.unavailable_models,not_discovered:analyst.not_discovered,stop_reason:analyst.stop_reason},null,1));
console.log('elapsed ms',Date.now()-started);
