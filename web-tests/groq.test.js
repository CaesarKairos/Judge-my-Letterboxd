import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {groqMessages,groqRequestBody,groqText,groqFinishReason,groqModels,groqChat,groqWithFallback} from '../functions/_lib/groq.js';
import {salvageJson} from '../functions/_lib/json-repair.js';

test('production JavaScript has no Gemini API endpoint',async()=>{
  const files=[];for(const root of ['functions','js']){const visit=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await visit(path);else if(path.endsWith('.js'))files.push(path);}};await visit(root);}
  for(const path of files)assert.doesNotMatch(await readFile(path,'utf8'),/generativelanguage\.googleapis\.com|x-goog-api-key/i,path);
});

test('Chat Completions messages, JSON mode, auth headers, tokens and response extraction',async t=>{
  const messages=groqMessages({system:'Editorial system',prompt:'Private archive'});
  assert.deepEqual(messages,[{role:'system',content:'Editorial system\n\nReturn exactly one valid JSON object. (um único objeto JSON válido.) Do not include Markdown, code fences, or text before or after the object.'},{role:'user',content:'Private archive'}]);
  const body=groqRequestBody({model:'m',system:'s',prompt:'p',max_completion_tokens:81});assert.equal(body.max_completion_tokens,81);assert.deepEqual(body.response_format,{type:'json_object'});assert.equal('responseSchema' in body,false);
  const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);let captured;
  globalThis.fetch=async(url,init)=>{captured={url:String(url),init};return Response.json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}],usage:{total_tokens:4}});};
  const result=await groqChat({env:{GROQ_API_KEY:'test-secret'},model:'m',system:'s',prompt:'p'});
  assert.equal(captured.url,'https://api.groq.com/openai/v1/chat/completions');assert.equal(new Headers(captured.init.headers).get('Authorization'),'Bearer test-secret');
  assert.equal(groqText(result.payload),'{"ok":true}');assert.equal(groqFinishReason(result.payload),'stop');assert.equal(result.usage.total_tokens,4);
});

test('JSON parsing and truncated JSON recovery stay available',()=>{
  assert.deepEqual(JSON.parse('{"a":1}'),{a:1});assert.deepEqual(salvageJson('{"a":1'),{a:1});
});

test('missing key is explicit and 400 is not retried',async t=>{
  await assert.rejects(groqChat({env:{},model:'m',prompt:'p'}),error=>error.details.reason==='missing_groq_key');
  const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({error:{message:'bad request'}},{status:400});};
  await assert.rejects(groqChat({env:{GROQ_API_KEY:'test'},model:'m',prompt:'p'}),error=>error.details.reason==='invalid_request');assert.equal(calls,1);
});

for(const [status,reason] of [[401,'invalid_api_key'],[403,'invalid_api_key'],[400,'invalid_request'],[429,'rate_limited'],[503,'provider_error']])test(`Groq HTTP ${status} is classified`,async t=>{
  const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);globalThis.fetch=async()=>Response.json({error:{message:'provider error'}},{status});
  await assert.rejects(groqChat({env:{GROQ_API_KEY:'test'},model:'m',prompt:'p'}),error=>error.details.reason===reason);
});

test('429 calls configured fallback once without repeating a model',async t=>{
  const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);const seen=[];
  globalThis.fetch=async(_url,init)=>{const model=JSON.parse(init.body).model;seen.push(model);return model==='primary'?Response.json({error:{message:'rate limit'}},{status:429}):Response.json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]});};
  const result=await groqWithFallback({env:{GROQ_API_KEY:'test'},models:['primary','backup','third'],prompt:'p'});
  assert.equal(result.model,'backup');assert.deepEqual(seen,['primary','backup']);assert.deepEqual(groqModels({GROQ_MODEL:'primary',GROQ_FALLBACK_MODELS:'backup,third'}),['primary','backup']);
});

test('timeout and one transient retry are bounded',async t=>{
  const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);let calls=0;
  globalThis.fetch=async()=>{calls++;if(calls===1)return Response.json({error:{message:'unavailable'}},{status:503});return Response.json({choices:[{finish_reason:'stop',message:{content:'{}'}}]});};
  await groqChat({env:{GROQ_API_KEY:'test'},model:'m',prompt:'p'});assert.equal(calls,2);
  globalThis.fetch=async()=>{throw new DOMException('aborted','TimeoutError');};
  await assert.rejects(groqChat({env:{GROQ_API_KEY:'test'},model:'m',prompt:'p',maxTransientRetries:0}),error=>error.details.reason==='timeout');
});
