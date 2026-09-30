import test from 'node:test';
import assert from 'node:assert/strict';
import {selectEditorialMoments,evaluateEditorialSelection,evaluateTopFourSemantics,normalizeAnalystPayload,ANALYST_MAX_OUTPUT_TOKENS} from '../functions/_lib/analyst.js';
import {buildAnalystContext} from '../functions/_lib/analyst-context.js';
import {ANALYST_SCHEMA,ANALYST_SEMANTICS_SCHEMA} from '../functions/_lib/analyst-schema.js';
import {mergeModels} from '../functions/_lib/models.js';
import {salvageJson as salvageFromRepair} from '../functions/_lib/json-repair.js';
import {salvageJson as salvageFromWriter} from '../functions/_lib/gemini.js';
import {buildScriptEngine,materializeCandidates} from '../functions/_lib/editorial.js';
import {judgeExport} from '../js/api.js';

// --- fixtures ---------------------------------------------------------------------------
const titles=['Alpha','Beta','Gamma','Delta','Epsilon','Zeta'];
// Five rated films keep these Analyst transport tests below the game-guarantee threshold;
// interaction repair has its own focused fixtures.
const films=titles.map((title,index)=>({film_key:`${title.toLocaleLowerCase()}|2000`,title,year:'2000',rating:index===5?null:4}));
const ids=['m-1','m-2','m-3','m-4','m-5','m-6'];
const profile={films,sessions:[{film_key:films[0].film_key,title:'Alpha',year:'2000',rating:4,date:'2026-01-01',rewatch:true,tags:['comfort'],index:1}],
  reviews:[],lists:[],topFour:films.slice(0,4),watchlist:2,likes:{films:1,reviews:2,lists:0},handle:'synthetic',name:'Synthetic'};
const analysis={moments:ids.map((id,index)=>({id,type:'stat',facts:`measurement ${index+1}`})),overview:{watched:6},
  relationships:{relations:[],tag_films:[]},review_style:null,review_coverage:{},affinity:[]};
const env=extra=>({GEMINI_API_KEY:'test-key',GEMINI_ANALYST_MODEL:'primary',GEMINI_MODEL_DISCOVERY:'0',...extra});
const finding=id=>({id,type:'stat',interestingness:.8,confidence:.8,observation:`observation ${id}`,why_interesting:'why'});
const selection=list=>list.map(finding);
const semanticsOf=rows=>rows.map(row=>({film_key:row.film_key,ingredients:['archetype','setting']}));
const answer=payload=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(payload)}]}}]});
const semanticsAnswer=rows=>answer({top_four_semantics:semanticsOf(rows)});
const bodyOf=options=>JSON.parse(options.body);
const promptsOf=calls=>calls.map(call=>bodyOf(call.options).contents[0].parts[0].text);

// The mock answers a queue of behaviours and keeps every request for inspection. A single
// function entry is a persistent handler instead of a one-shot answer.
const responder=(t,list)=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url:String(url),options});
    const next=list.length===1&&typeof list[0]==='function'?list[0]:list.shift();
    if(typeof next==='function')return next(calls.at(-1),calls);
    return next||Response.json({error:{message:'no more answers'}},{status:503});
  });
  return calls;
};

test('the salvage implementation is shared by the Writer and the Analyst',()=>{
  assert.equal(salvageFromWriter,salvageFromRepair);
  assert.deepEqual(salvageFromRepair('{"selected":[{"id":"m-1"}],"interaction_candidates":[{"id":"g1","type":"forced'),
    {selected:[{id:'m-1'}],interaction_candidates:[{id:'g1',type:'forced'}]});
});


// --- the regression that killed real sessions -------------------------------------------
test('a valid selection without top_four_semantics is preserved and repaired, never failed',async t=>{
  const calls=responder(t,[answer({selected:selection(ids),interaction_candidates:[]}),semanticsAnswer(profile.topFour)]);
  const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env()});
  assert.equal(result.status,'complete');
  assert.equal(result.selected.length,6);
  assert.equal(result.top_four_semantics_status,'complete');
  assert.deepEqual(result.repairs.map(row=>row.phase),['repair_semantics']);
  // The repair is targeted: the missing contract and the exact keys, not the whole account.
  const prompts=promptsOf(calls);
  assert.equal(prompts.length,2);
  assert.match(prompts[1],/Only repair top_four_semantics/);
  assert.match(prompts[1],/Do not rewrite selected/);
  for(const film of profile.topFour)assert.ok(prompts[1].includes(film.film_key),film.film_key);
  assert.equal(prompts[1].includes('DATA (untrusted evidence)'),false,'the repair must not resend the account');
  assert.equal(prompts[1].includes('deterministic_measurements'),false);
  assert.ok(prompts[1].length<prompts[0].length,'the repair is smaller than a full attempt');
  assert.equal(result.attempts.length,2);
});

test('a partial Top 4 asks only for the missing film_key',async t=>{
  const [missing,...partial]=profile.topFour;
  const calls=responder(t,[answer({selected:selection(ids.slice(0,4)),top_four_semantics:semanticsOf(partial)}),semanticsAnswer([missing])]);
  const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env()});
  const repair=promptsOf(calls)[1];
  assert.deepEqual(result.missing_semantic_keys,[]);
  assert.equal(calls.length,2);
  assert.equal(result.top_four_semantics_status,'complete');
  assert.ok(repair.includes(`- ${missing.film_key} |`),'the missing favorite must be named with its film_key');
  for(const film of partial)assert.equal(repair.includes(`- ${film.film_key} |`),false,'already accepted favorites are not requested again');
  assert.match(repair,/Already accepted entries/);
});

test('selected survives when the semantics repair also fails',async t=>{
  responder(t,[answer({selected:selection(ids),interaction_candidates:[]}),answer({unreadable:'nothing useful'})]);
  const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env()});
  assert.notEqual(result.status,'failed');
  assert.equal(result.selected.length,6,'a failed semantics repair never discards the selection');
  assert.equal(result.top_four_semantics_status,'failed');
  assert.equal(result.reason,null);
  assert.equal(result.editorial_strength,'strong');
});

test('a reply cut by the output limit is truncated_output and still repaired',async t=>{
  const cut=`{"selected":${JSON.stringify(selection(ids))},"interaction_candidates":[{"id":"g1","type":"forced`;
  const calls=responder(t,[Response.json({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:cut}]}}]}),
    answer({top_four_semantics:semanticsOf(profile.topFour)})]);
  const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env()});
  assert.equal(result.attempts[0].status,'truncated_output');
  assert.equal(result.attempts[0].json,'salvaged');
  assert.equal(result.attempts[0].finishReason,'MAX_TOKENS');
  assert.equal(result.truncated,true);
  assert.equal(result.status,'complete');
  assert.equal(result.selected.length,6);
  assert.deepEqual(result.repairs.map(row=>row.phase),['repair_semantics']);
  assert.equal(calls.length,2);

// --- transport, budget and chain ---------------------------------------------------------
test('the request declares the schema, the output budget and no thinking budget',async t=>{
  const calls=responder(t,[answer({selected:selection(ids),interaction_candidates:[],top_four_semantics:semanticsOf(profile.topFour)})]);
  await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env()});
  const config=bodyOf(calls[0].options).generationConfig;
  assert.equal(config.responseMimeType,'application/json');
  assert.deepEqual(config.responseSchema,ANALYST_SCHEMA);
  assert.deepEqual(config.responseSchema.required,['selected','semantic_findings','interaction_candidates','top_four_semantics']);
  assert.equal(config.maxOutputTokens,ANALYST_MAX_OUTPUT_TOKENS);
  assert.equal(config.maxOutputTokens,8192);
  // Thinking tokens used to eat the visible budget and cut the JSON mid-array.
  assert.deepEqual(config.thinkingConfig,{thinkingBudget:0});
  assert.equal(bodyOf(calls[0].options).contents[0].parts[0].text.match(/top_four_semantics[\s\S]*MUST contain one entry for each Favorite Film/)?.[0]!==undefined,true);
});

test('the semantics repair asks for the semantics contract only',async t=>{
  const calls=responder(t,[answer({selected:selection(ids)}),semanticsAnswer(profile.topFour)]);
  await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env()});
  assert.deepEqual(Object.keys(ANALYST_SEMANTICS_SCHEMA.properties),['top_four_semantics']);
  assert.deepEqual(bodyOf(calls[1].options).generationConfig.responseSchema,ANALYST_SEMANTICS_SCHEMA);
});

test('429 and 404 advance the chain instead of repeating the same model',async t=>{
  const calls=responder(t,[Response.json({error:{}},{status:429}),Response.json({error:{}},{status:404}),
    answer({selected:selection(ids),interaction_candidates:[],top_four_semantics:semanticsOf(profile.topFour)})]);
  const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env({GEMINI_ANALYST_FALLBACK_MODELS:'backup-a,backup-b'})});
  assert.deepEqual(result.chain,['primary','backup-a','backup-b']);
  assert.deepEqual(result.attempts.map(row=>row.status),['http_429','http_404','ok']);
  assert.deepEqual(calls.map(call=>call.url.match(/models\/([^:]+)/)[1]),['primary','backup-a','backup-b']);
  assert.deepEqual(result.unavailable_models,['primary','backup-a']);
  assert.equal(result.status,'complete');
});

test('discovery extends the chain behind the configured primary',async t=>{
  const calls=responder(t,[
    ()=>Response.json({models:[{name:'models/full-A',supportedGenerationMethods:['generateContent']},
      {name:'models/full-B',supportedGenerationMethods:['generateContent']},{name:'models/lite-C',supportedGenerationMethods:['generateContent']}]}),
    answer({selected:selection(ids),interaction_candidates:[],top_four_semantics:semanticsOf(profile.topFour)})]);
  const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env({GEMINI_MODEL_DISCOVERY:'1'})});
  assert.deepEqual(result.chain,['primary','full-A','full-B','lite-C']);
  assert.equal(calls[1].url.includes('/models/primary:generateContent'),true);
  assert.equal(result.status,'complete');
});

test('three genuinely strong findings are thin, never a failure',async t=>{
  const strong=ids.slice(0,3),complete=answer({selected:selection(strong),interaction_candidates:[],top_four_semantics:semanticsOf(profile.topFour)});
  const calls=responder(t,[complete,complete]);
  const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env()});
  assert.equal(result.status,'thin');
  assert.equal(result.reason,null);
  assert.equal(result.editorial_strength,'thin');
  assert.deepEqual(result.repairs.map(row=>row.phase),['repair_findings']);
  assert.match(promptsOf(calls)[1],/genuinely strong/);
  assert.match(promptsOf(calls)[1],/three excellent findings/);
  // A thin selection still becomes a script: the session is shorter, not broken.
  assert.equal(buildScriptEngine(materializeCandidates(result.selected,analysis.moments),0).length,3);
});

// --- the context sent to the Analyst -----------------------------------------------------
test('the Analyst context keeps every review once and drops only duplicated tables',()=>{
  const raw_export={file_count:7,unknown_files:[],files:{
    'profile.csv':[{Username:'synthetic','Display Name':'Synthetic','Favorite Films':'https://boxd.it/a'}],
    'watched.csv':[{Date:'2026-01-01',Name:'Alpha',Year:'2000','Letterboxd URI':'https://boxd.it/a'}],
    'ratings.csv':[{Date:'2026-01-02',Name:'Alpha',Year:'2000','Letterboxd URI':'https://boxd.it/a',Rating:'4'}],
    'diary.csv':[{Date:'2026-01-03',Name:'Alpha',Year:'2000',Rating:'4',Rewatch:'Yes',Tags:'comfort','Watched Date':'2026-01-03'}],
    'reviews.csv':[{Date:'2026-01-03',Name:'Alpha',Year:'2000',Review:'texto da review com citacao',Rating:'4'}],
    'watchlist.csv':[{Date:'2025-03-09',Name:'Grave of the Fireflies',Year:'1988','Letterboxd URI':'https://boxd.it/z'}],
    'comments.csv':[{Date:'2026-01-29',Content:'https://boxd.it/x',Comment:'Menor que 3'}]}};
  const rich={...profile,reviews:[{review_id:'review-1',film_key:films[0].film_key,title:'Alpha',year:'2000',rating:4,date:'2026-01-03',
    tags:['comfort'],text:'texto da review com citacao',segments:[{type:'text',text:'texto da review com '},{type:'blockquote',text:'citacao'}]}]};
  const context=buildAnalystContext({profile:rich,analysis,raw_export}),text=JSON.stringify(context);
  assert.equal(text.includes('raw_export'),false,'the raw tables are not sent twice');
  assert.equal(context.reviews[0].text,rich.reviews[0].text,'reviews keep their whole text');
  assert.equal(context.reviews[0].segments,undefined,'the word-by-word copy is gone');
  assert.deepEqual(context.reviews[0].markup,['text','blockquote'],'markup survives as types');
  assert.equal(text.split(rich.reviews[0].text).length,2,'the review body appears exactly once');
  assert.deepEqual(context.export_inventory.files.map(row=>row.path),Object.keys(raw_export.files));
  assert.equal(context.export_inventory.unnormalized_files['reviews.csv'],undefined);
  assert.equal(context.export_inventory.unnormalized_files['watchlist.csv'].length,1);
  assert.equal(context.export_inventory.unnormalized_files['comments.csv'].length,1);
  // Fields that exist nowhere else survive: logging/rating dates, rewatch digest, watchlist.
  assert.deepEqual(context.library_log,[{film_key:films[0].film_key,logged:'2026-01-01',rated:'2026-01-02'}]);
  assert.equal(context.rewatches.length,1);
  assert.equal(context.rewatches[0].review_id,'review-1');
  assert.equal(context.watchlist.added.length,1);
  assert.equal(context.account.top_four_expected,4);
  assert.equal(context.deterministic_measurements.length,analysis.moments.length);
});

test('the frontend tells an Analyst failure apart from a Writer failure',async t=>{
  const file=new File(['PK'],'test.zip');
  for(const [error,expected] of [['analyst_unavailable','analystUnavailable'],['writer_unavailable','writerUnavailable']]){
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({error,stage:error.split('_')[0],retryable:true,attempts:[{model:'m',status:'http_429'}]},{status:503}));
    await assert.rejects(judgeExport(file,'pt-BR'),new RegExp(expected));
    mock.mock.restore();
  }
  // The legacy reason keeps its own copy, so an old deployment still says something true.
  const legacy=t.mock.method(globalThis,'fetch',async()=>Response.json({error:'ai_unavailable'},{status:503}));
  await assert.rejects(judgeExport(file,'pt-BR'),/aiUnavailable/);
  legacy.mock.restore();
});


test('a real failure is reported as a failure and never fabricates candidates',async t=>{
  responder(t,[()=>{throw new TypeError('fetch failed');},Response.json({error:{}},{status:429}),
    Response.json({error:{}},{status:500}),
    Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'nao vou responder JSON'}]}}]})]);
  const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',
    env:env({GEMINI_ANALYST_FALLBACK_MODELS:'backup-a,backup-b,backup-c'})});
  assert.equal(result.status,'failed');
  // A model did answer, so the failure is "no usable analysis"; the transport fact stays in stop_reason.
  assert.equal(result.reason,'no_usable_analysis');
  assert.equal(result.stop_reason,'network');
  assert.deepEqual(result.selected,[]);
  assert.deepEqual(result.interaction_candidates,[]);
  assert.equal(result.editorial_strength,'empty');
  assert.equal(result.top_four_semantics_status,'failed');
  assert.deepEqual(result.attempts.map(row=>row.status).slice(0,4),['network','http_429','http_500','invalid_response']);
  // Never promoted from the deterministic pool: that was the bug this contract forbids.
  assert.notDeepEqual(result.selected,analysis.moments);
});

test('an exhausted quota is named instead of hidden behind a timeout',async t=>{
  const quota=()=>Response.json({error:{code:429,message:'You exceeded your current quota, please check your plan and billing details.'}},{status:429});
  responder(t,[quota(),quota()]);
  const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env({GEMINI_ANALYST_FALLBACK_MODELS:'backup-a'})});
  assert.equal(result.status,'failed');
  assert.equal(result.reason,'quota_exceeded');
  assert.deepEqual(result.unavailable_models,['primary','backup-a']);
});

});

// --- the chain is limited by the deadline, never by a fixed count ------------------------
test('every discovered model is reachable: models 7 and 8 run when the first six fail fast',async t=>{
  const wide=Array.from({length:8},(_,index)=>`gemini-3.${index+1}-flash`);
  const calls=responder(t,[call=>{
    if(!call.url.includes(':generateContent'))return Response.json({models:wide.map(name=>({name:`models/${name}`,supportedGenerationMethods:['generateContent']}))});
    if(call.url.includes('gemini-3.2-flash')||call.url.includes('gemini-3.1-flash'))
      return answer({selected:selection(ids),interaction_candidates:[],top_four_semantics:semanticsOf(profile.topFour)});
    return Response.json({error:{code:404,message:'gone'}},{status:404});
  }]);
  const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env({GEMINI_MODEL_DISCOVERY:'1'})});
  // primary + 8 discovered, all of them in the chain: nothing is cut before the deadline says so.
  assert.equal(result.chain.length,9);
  assert.equal(result.status,'complete');
  assert.ok(['gemini-3.2-flash','gemini-3.1-flash'].includes(result.model),String(result.model));
  const attempted=result.attempts.map(row=>row.model);
  assert.equal(attempted.length,8,'the eight generateContent attempts');
  assert.equal(attempted.at(-1),'gemini-3.2-flash');
  assert.equal(calls.length,9);
  // A 404 answered in milliseconds never stopped a later discovered model.
  assert.equal(result.attempts.filter(row=>row.status==='http_404').length,7);
});

test('a 429 or a 404 is tried once per model and never retried',async t=>{
  const calls=responder(t,[Response.json({error:{code:429,message:'quota'}},{status:429}),
    Response.json({error:{code:404,message:'gone'}},{status:404}),
    answer({selected:selection(ids),interaction_candidates:[],top_four_semantics:semanticsOf(profile.topFour)})]);
  const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env({GEMINI_ANALYST_FALLBACK_MODELS:'backup-a,backup-b'})});
  assert.deepEqual(calls.map(call=>call.url.match(/models\/([^:]+)/)[1]),['primary','backup-a','backup-b']);
  assert.equal(result.attempts.filter(row=>row.model==='primary').length,1);
  assert.equal(result.attempts.filter(row=>row.model==='backup-a').length,1);
  assert.equal(result.status,'complete');
});

test('a 5xx gets one short retry, then the chain advances',async t=>{
  const calls=responder(t,[Response.json({error:{code:503,message:'high demand'}},{status:503}),
    Response.json({error:{code:503,message:'high demand'}},{status:503}),
    answer({selected:selection(ids),interaction_candidates:[],top_four_semantics:semanticsOf(profile.topFour)})]);
  const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env({GEMINI_ANALYST_FALLBACK_MODELS:'backup-a'})});
  const primary=result.attempts.filter(row=>row.model==='primary');
  assert.deepEqual(primary.map(row=>row.phase),['initial','retry_5xx']);
  assert.deepEqual(primary.map(row=>row.status),['http_503','http_503']);
  assert.equal(result.status,'complete');
  assert.equal(result.model,'backup-a');
  assert.equal(calls.length,3);
});

test('a non-2xx answer is never parsed as generation output',async t=>{
  responder(t,[Response.json({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'You exceeded your current quota'}},{status:429})]);
  const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env()});
  const [attempt]=result.attempts;
  assert.equal(attempt.status,'http_429');
  assert.equal(attempt.http,429);
  assert.deepEqual(attempt.provider_error,{code:429,status:'RESOURCE_EXHAUSTED',message:'You exceeded your current quota'});
  assert.equal(attempt.parse_error,undefined,'an error body is not a truncated reply');
  assert.equal(attempt.json,undefined);
  assert.equal(attempt.finishReason,undefined);
  assert.equal(result.reason,'quota_exceeded');
});

test('the deadline stops the walk instead of looping forever',async t=>{
  const calls=responder(t,[answer({selected:selection(ids),top_four_semantics:semanticsOf(profile.topFour)})]);
  const result=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:env({__TEST_ANALYST_DEADLINE_MS:-1,GEMINI_ANALYST_FALLBACK_MODELS:'backup-a,backup-b'})});
  assert.equal(calls.length,0,'not a single request after the deadline');
  assert.equal(result.status,'failed');
  assert.equal(result.stop_reason,'deadline');
  assert.equal(result.reason,'deadline');
  assert.deepEqual(result.selected,[]);
});

test('a model that is unavailable in this run is not paid for again',async t=>{
  const calls=responder(t,[call=>call.url.includes('/models/primary:')?Response.json({error:{code:404,message:'gone'}},{status:404})
    :answer({selected:selection(ids),interaction_candidates:[],top_four_semantics:semanticsOf(profile.topFour)})]);
  const shared=env({GEMINI_ANALYST_FALLBACK_MODELS:'backup-a'});
  const first=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:shared});
  assert.equal(first.attempts.filter(row=>row.model==='primary').length,1);
  assert.equal(first.status,'complete');
  const before=calls.length;
  const second=await selectEditorialMoments({profile,analysis,raw_export:{},locale:'pt-BR',env:shared});
  assert.equal(calls.length,before+1,'the Writer stage would not pay for the dead model again');
  assert.equal(second.attempts.some(row=>row.model==='primary'),false);
  assert.equal(second.status,'complete');
  assert.equal(second.unavailable_models.includes('primary'),true);
});

