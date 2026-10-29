import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_DEFAULT_MODEL,AI_DEFAULT_FALLBACK,workersAiModels,workersAiMessages,workersAiRequest,workersAiText,workersAiFinishReason,workersAiChat,workersAiWithFallback,classifyWorkersAiError} from '../functions/_lib/workers-ai.js';
import {salvageJson} from '../functions/_lib/json-repair.js';

test('Workers AI defaults and bounded primary/fallback chain',()=>{
  assert.equal(AI_DEFAULT_MODEL,'@cf/openai/gpt-oss-120b');assert.equal(AI_DEFAULT_FALLBACK,'@cf/openai/gpt-oss-20b');
  assert.deepEqual(workersAiModels({}),[AI_DEFAULT_MODEL,AI_DEFAULT_FALLBACK]);
  assert.deepEqual(workersAiModels({AI_MODEL:'primary',AI_FALLBACK_MODELS:'secondary,third'}),['primary','secondary']);
  assert.deepEqual(workersAiModels({AI_ANALYST_MODEL:'analyst',AI_MODEL:'primary'} ,'ANALYST'),['analyst',AI_DEFAULT_FALLBACK]);
});

test('native run options request JSON mode and normalize the actual GPT-OSS response shape',async()=>{
  const input=workersAiRequest({system:'system',prompt:'prompt',max_completion_tokens:91});
  assert.deepEqual(input.messages,workersAiMessages({system:'system',prompt:'prompt'}));
  assert.equal(input.max_tokens,91);assert.deepEqual(input.response_format,{type:'json_object'});assert.equal('model'in input,false);
  assert.equal(workersAiText({response:'{"ok":true}'}),'{"ok":true}');
  assert.equal(workersAiText({response:'',choices:[{message:{content:'{"actual":true}'}}]}),'{"actual":true}');
  assert.equal(workersAiText({output_text:'{}'}),'{}');assert.equal(workersAiText({choices:[{message:{content:'{}'}}]}),'{}');
  assert.equal(workersAiFinishReason({choices:[{finish_reason:'stop'}]}),'stop');
  let call;const AI={run:async(...args)=>(call=args,{response:'{"ok":true}',usage:{tokens:5}})};
  const result=await workersAiChat({env:{AI},model:AI_DEFAULT_MODEL,system:'S',prompt:'P'});
  assert.equal(call[0],AI_DEFAULT_MODEL);assert.equal(call[1].messages[1].content,'P');assert.deepEqual(call[1].response_format,{type:'json_object'});
  assert.equal(result.text,'{"ok":true}');assert.equal(result.status,200);assert.equal(result.usage.tokens,5);
});

test('JSON parsing and controlled truncated JSON recovery still require a validator for success',()=>{
  assert.deepEqual(JSON.parse(workersAiText({response:'{"ok":true}'})),{ok:true});
  assert.deepEqual(salvageJson('{"a":1'),{a:1});assert.equal(salvageJson('not json'),null);
});

test('missing binding, empty output, quota, context, unavailable and invalid request are categorized',async()=>{
  await assert.rejects(workersAiChat({env:{},model:'m',prompt:'p'}),e=>e.details.reason==='binding_missing');
  await assert.rejects(workersAiChat({env:{AI:{run:async()=>({})}},model:'m',prompt:'p'}),e=>e.details.reason==='invalid_response');
  assert.equal(classifyWorkersAiError(Object.assign(new Error('Daily quota exceeded'),{status:429})),'quota_exceeded');
  assert.equal(classifyWorkersAiError(Object.assign(new Error('Context window exceeded'),{status:400})),'context_exceeded');
  assert.equal(classifyWorkersAiError(Object.assign(new Error('bad parameters'),{status:400})),'invalid_request');
  assert.equal(classifyWorkersAiError(Object.assign(new Error('missing model'),{status:404})),'model_unavailable');
});

test('fallback advances once after quota and never emits provider content',async()=>{
  const seen=[],AI={run:async(model)=>{seen.push(model);if(model==='primary')throw Object.assign(new Error('quota exceeded private prompt'),{status:429});return {response:'{"ok":true}'};}};
  const result=await workersAiWithFallback({env:{AI},models:['primary','backup','unused'],system:'private',prompt:'secret'});
  assert.equal(result.model,'backup');assert.deepEqual(seen,['primary','backup']);
  const AI2={run:async()=>{throw Object.assign(new Error('quota exceeded private prompt'),{status:429});}};
  await assert.rejects(workersAiWithFallback({env:{AI:AI2},models:['one','two'],prompt:'secret'}),e=>{
    assert.equal(e.details.attempts.length,2);assert.equal(JSON.stringify(e.details).includes('private prompt'),false);return true;
  });
});

test('deadline and transient retry are bounded',async()=>{
  let calls=0;const AI={run:async()=>{calls++;if(calls===1)throw Object.assign(new Error('temporary'),{status:503});return {response:'{}'};}};
  await workersAiChat({env:{AI},model:'m',prompt:'p',maxTransientRetries:1});assert.equal(calls,2);
  await assert.rejects(workersAiChat({env:{AI:{run:()=>new Promise(()=>{})}},model:'m',prompt:'p',deadline:Date.now()+15,timeoutMs:10,maxTransientRetries:0}),e=>e.details.reason==='timeout');
});
