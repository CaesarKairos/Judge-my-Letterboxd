import {onRequestPost} from '../functions/api/judge.js';
import {syntheticZip} from '../web-tests/synthetic-export.js';

// This command always uses fictional rows and an explicitly simulated binding. The real binding
// probe is `npm run probe:workers-ai`; no user export is read by this pipeline check.
const zip=syntheticZip(),payload={
  opening:{greeting:['Certo.'],archetype_lead:'Você deve ser o...',archetype_phrase:'astronauta no baile suburbano',archetype_after:['Grande demais.'],username_line:'Vou ficar com fictionalcritic.',taste_bit:{lead:'Seu gosto parece',strike:'errado',correction:'ousado',tail:'na medida.'},judge_claim:'Eu julgo daqui.',transition:['Vamos aos dados.']},
  moments:[{id:'synthetic-moment',type:'review',label:'EVIDÊNCIA FICTÍCIA',evidence_refs:['reviews.csv#row:2'],attachments:[{type:'review_quote',review_ref:'reviews.csv#row:2'}],lines:['Esta observação veio do ZIP sintético.']}],
  games:[],closer:['Fim do teste.'],ending:{title:'Sessão sintética concluída.'},profile_review:{text:'Este perfil fictício tem sinais consistentes.',evidence_refs:['reviews.csv#row:2']}
};
const AI={run:async()=>({response:JSON.stringify(payload),finish_reason:'stop'})};
const form=new FormData();form.set('locale','pt-BR');form.set('export',new File([zip],'synthetic-letterboxd.zip',{type:'application/zip'}));
const request=new Request('http://local/api/judge',{method:'POST',body:form});
const response=await onRequestPost({request,env:{AI,__TEST_PIPELINE_MODE:'freeform'}}),result=await response.json();
if(!response.ok||result.pipeline_mode!=='freeform'||result.render?.runtime!=='cloudflare-pages'||!Array.isArray(result.events)||!result.profile_review)throw new Error(JSON.stringify({status:response.status,error:result.error,reason:result.reason,pipeline:result.pipeline_mode}));
console.log(JSON.stringify({pipeline:result.pipeline_mode,status:response.status,runtime:result.render.runtime,generation:result.render.ai_generation,events:result.events.length,beats:result.beats.length,model:result.render.served_model,simulated:true,zip:'fictional'}));
