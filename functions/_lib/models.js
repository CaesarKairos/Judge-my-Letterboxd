import {groqModels,GROQ_MAX_MODELS} from './groq.js';

export const FREEFORM_MODEL_LIMIT=GROQ_MAX_MODELS;
export const MODEL_SAFETY_CEILING=GROQ_MAX_MODELS;
export const DISCOVERY_LIMIT=0;
export const discoverTextModels=async()=>[];
export const mergeModels=(configured=[],_discovered=[],limit=GROQ_MAX_MODELS)=>[...new Set(configured.filter(Boolean))].slice(0,Math.min(limit,GROQ_MAX_MODELS));
export const configuredWithoutDiscovery=()=>[];
export const describeChain=chain=>chain.map((name,index)=>`${index+1}. ${name}`);
const RUN_KEY='__MODEL_RUN_UNAVAILABLE';
export const modelRunRegistry=env=>{if(!env)return new Set();if(!(env[RUN_KEY] instanceof Set))env[RUN_KEY]=new Set();return env[RUN_KEY];};
export const noteModelFailure=(env,model,status)=>{if([404,429].includes(Number(status)))modelRunRegistry(env).add(model);};
export const modelUnavailable=(env,model)=>modelRunRegistry(env).has(model);
export {groqModels};
