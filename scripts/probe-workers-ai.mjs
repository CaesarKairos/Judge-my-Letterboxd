import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const port=Number(process.env.WORKERS_AI_PROBE_PORT||8799),model=process.argv[2]||'@cf/openai/gpt-oss-120b',url=`http://127.0.0.1:${port}/?model=${encodeURIComponent(model)}`,wrangler=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
let report,child;
try{
  child=spawn(process.execPath,[wrangler,'dev','--config','scripts/wrangler-ai-probe.toml','--ip','127.0.0.1','--port',String(port)],{stdio:'ignore',windowsHide:true});
  let ready=false;
  for(let i=0;i<50;i++){
    if(child.exitCode!==null)throw new Error('wrangler_start_failed');
    try{const response=await fetch(url,{signal:AbortSignal.timeout(1500)});report=await response.json();ready=true;break;}catch{}
    await delay(400);
  }
  if(!ready)throw new Error('wrangler_probe_timeout');
  console.log(JSON.stringify(report));
  if(report.http_status!==200||!report.json_valid)process.exitCode=1;
}catch(error){console.log(JSON.stringify({http_status:0,model,json_valid:false,failure:error.message}));process.exitCode=1;}
finally{child?.kill('SIGTERM');}
