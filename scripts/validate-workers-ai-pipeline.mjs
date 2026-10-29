import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {basename,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {syntheticZip} from '../web-tests/synthetic-export.js';

const zipPath=process.argv[2],port=Number(process.env.WORKERS_AI_PIPELINE_PORT||8798),base=`http://127.0.0.1:${port}`,wrangler=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
let child;
try{
  child=spawn(process.execPath,[wrangler,'pages','dev','dist','--ai','AI','--ip','127.0.0.1','--port',String(port)],{stdio:'ignore',windowsHide:true});
  let ready=false;
  for(let i=0;i<80;i++){
    if(child.exitCode!==null)throw new Error('wrangler_start_failed');
    try{const health=await fetch(`${base}/api/judge`,{signal:AbortSignal.timeout(1000)});if(health.ok){ready=true;break;}}catch{}
    await delay(500);
  }
  if(!ready)throw new Error('wrangler_start_timeout');
  // Optional local-only sizing/validation run. Never point this at production: output remains
  // limited to counts, model IDs, statuses and token usage, with no profile or response text.
  const zip=zipPath?await readFile(resolve(zipPath)):syntheticZip(),form=new FormData();form.set('locale','pt-BR');form.set('export',new File([zip],zipPath?basename(zipPath):'synthetic-letterboxd.zip',{type:'application/zip'}));
  const response=await fetch(`${base}/api/judge`,{method:'POST',body:form,signal:AbortSignal.timeout(240000)}),result=await response.json();
  const attemptRows=result.ai?.attempts||result.attempts||result.details?.attempts||[];
  const summary={http_status:response.status,pipeline:result.pipeline_mode||null,runtime:result.render?.runtime||null,provider:result.render?.model||null,model:result.render?.served_model||null,generation:result.render?.ai_generation||null,events:Array.isArray(result.events)?result.events.length:0,beats:Array.isArray(result.beats)?result.beats.length:0,attempts:attemptRows.map(row=>({model:row.model,status:row.status,reason:row.reason,usage:row.usage})),synthetic_zip:!zipPath,local_only:true,valid_presentation:Boolean(result.profile_review&&result.opening&&Array.isArray(result.events)&&Array.isArray(result.beats)),failure:response.ok?null:{error:result.error,reason:result.reason||result.details?.reason}};
  console.log(JSON.stringify(summary));
  if(!response.ok||summary.pipeline!=='freeform'||summary.provider!=='workers-ai'||!summary.valid_presentation)process.exitCode=1;
}catch(error){console.log(JSON.stringify({http_status:0,synthetic_zip:!zipPath,local_only:true,failure:error.message}));process.exitCode=1;}
finally{child?.kill('SIGTERM');}
