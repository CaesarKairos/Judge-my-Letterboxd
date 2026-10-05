import {existsSync,mkdtempSync,readdirSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url))),require=createRequire(import.meta.url);
const run=(command,args)=>{const result=spawnSync(command,args,{cwd:root,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);};
const walk=directory=>readdirSync(directory).flatMap(name=>{const path=join(directory,name);return statSync(path).isDirectory()?walk(path):[path];});

for(const dependency of ['react','@cloudflare/pages-plugin-vercel-og/api'])require.resolve(dependency);
const output=mkdtempSync(join(tmpdir(),'judge-pages-functions-'));
try{
  const npmCli=process.env.npm_execpath;if(!npmCli)throw new Error('npm CLI não encontrado. Execute este check com npm run check:cloudflare.');
  run(process.execPath,[npmCli,'run','build']);
  const wrangler=join(root,'node_modules','wrangler','bin','wrangler.js');
  if(!existsSync(wrangler))throw new Error('Wrangler local não encontrado. Execute npm ci.');
  run(process.execPath,[wrangler,'pages','functions','build','--outdir',output]);
  const files=walk(output),bundle=files.find(path=>path.endsWith('index.js')),wasm=files.filter(path=>path.endsWith('.wasm'));
  if(!bundle||wasm.length<2)throw new Error('Bundle incompleto: o renderer OG real não foi empacotado.');
  const source=readFileSync(bundle,'utf8');
  if(source.includes("import('@cloudflare/pages-plugin-vercel-og/api')")||source.includes('from "react"'))throw new Error('O bundle manteve imports npm sem resolver.');
  console.log(`Cloudflare Pages bundle OK: ${files.length} arquivos, ${wasm.length} módulos WASM.`);
}finally{rmSync(output,{recursive:true,force:true});}
