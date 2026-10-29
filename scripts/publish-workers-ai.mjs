import {spawnSync} from 'node:child_process';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {syntheticZip} from '../web-tests/synthetic-export.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url))),wrangler=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url)),project='judge-my-letterboxd';
const command=(args,{cwd=root,input}={})=>{
  const result=spawnSync(process.execPath,[wrangler,...args],{cwd,encoding:'utf8',input,windowsHide:true,maxBuffer:8*1024*1024});
  if(result.error||result.status!==0)throw new Error(`wrangler_${args.slice(0,3).join('_')}_failed`);
  return result.stdout||'';
};
const putSecret=(name,value)=>{command(['pages','secret','put',name,'--project-name',project],{input:`${value}\n`});};

let tempDir,tmdbSecret;
try{
  const config=await readFile(join(root,'wrangler.toml'),'utf8');
  if(!/^\[env\.production\.ai\]\s*\r?\nbinding\s*=\s*"AI"/m.test(config))throw new Error('workers_ai_production_binding_missing_from_pages_config');
  const deployments=JSON.parse(command(['pages','deployment','list','--project-name',project,'--json']));
  const recent=Array.isArray(deployments)?deployments:deployments.value||deployments.result||[];
  const production=recent.find(row=>(row.environment||row.Environment)==='Production');
  if((production?.branch||production?.Branch)!=='main')throw new Error('production_branch_is_not_main');

  // If TMDB is not already an encrypted secret, preserve its existing Pages variable as a
  // secret without writing its value into the repository or printing it.
  const secrets=command(['pages','secret','list','--project-name',project]);
  if(!secrets.includes('TMDB_API_KEY: Value Encrypted')){
    tempDir=await mkdtemp(join(tmpdir(),'jml-pages-config-'));
    command(['pages','download','config',project,'--cwd',tempDir]);
    const downloaded=await readFile(join(tempDir,'wrangler.toml'),'utf8');let section='';
    for(const line of downloaded.split(/\r?\n/)){
      const header=line.match(/^\s*(\[[^\]]+\])\s*$/);if(header){section=header[1];continue;}
      if(section==='[env.production.vars]'){
        const match=line.match(/^\s*TMDB_API_KEY\s*=\s*"([^"]*)"\s*$/);if(match){tmdbSecret=match[1];break;}
      }
    }
    if(!tmdbSecret)throw new Error('existing_tmdb_value_unavailable');
  }

  // Keep the live site open even if the deployment is rejected.
  putSecret('JUDGE_MAINTENANCE_MODE','0');
  const deployOutput=command(['pages','deploy','dist','--project-name',project,'--branch','main']);
  const deployed=deployOutput.match(/https:\/\/[a-f0-9-]+\.judge-my-letterboxd\.pages\.dev/i)?.[0]||'https://judge-my-letterboxd.pages.dev';
  if(tmdbSecret)putSecret('TMDB_API_KEY',tmdbSecret);
  putSecret('JUDGE_MAINTENANCE_MODE','0');
  tmdbSecret='';

  const rootUrl='https://judge-my-letterboxd.pages.dev',home=await fetch(rootUrl,{redirect:'follow',signal:AbortSignal.timeout(20000)});
  const apiResponse=await fetch(`${rootUrl}/api/judge`,{signal:AbortSignal.timeout(20000)}),health=await apiResponse.json();
  const homeText=await home.text();
  const prodForm=new FormData();prodForm.set('locale','pt-BR');prodForm.set('export',new File([syntheticZip()],'synthetic-letterboxd.zip',{type:'application/zip'}));
  const post=await fetch(`${rootUrl}/api/judge`,{method:'POST',body:prodForm,signal:AbortSignal.timeout(240000)}),result=await post.json();
  const attempts=(result.ai?.attempts||result.attempts||[]).map(row=>({model:row.model,status:row.status,reason:row.reason,usage:row.usage}));
  const summary={deployment_url:deployed,http_status:post.status,home_status:home.status,maintenance_page:homeText.includes('Voltamos em breve'),runtime:health.runtime,pipeline:health.pipeline,provider:health.provider,ai_binding_configured:health.ai_binding_configured,synthetic_zip:true,post_provider:result.render?.model||null,model:result.render?.served_model||null,generation:result.render?.ai_generation||null,events:Array.isArray(result.events)?result.events.length:0,beats:Array.isArray(result.beats)?result.beats.length:0,attempts,valid_presentation:Boolean(result.profile_review&&result.opening&&Array.isArray(result.events)&&Array.isArray(result.beats)),tmdb_secret_preserved:true,maintenance_secret_set_to_zero:true};
  console.log(JSON.stringify(summary));
  if(home.status!==200||apiResponse.status!==200||health.pipeline!=='freeform'||health.provider!=='workers-ai'||!health.ai_binding_configured||homeText.includes('Voltamos em breve')||!post.ok||result.render?.model!=='workers-ai'||!summary.valid_presentation)process.exitCode=1;
}catch(error){console.log(JSON.stringify({deployment_attempted:true,failure:error.message}));process.exitCode=1;}
finally{
  tmdbSecret='';
  if(tempDir)await rm(tempDir,{recursive:true,force:true});
}
