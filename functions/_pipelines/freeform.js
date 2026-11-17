import {buildFreeformArchive} from '../_lib/freeform/archive-json.js';
import {freeformJudge} from '../_lib/freeform/judge.js';
import {materializeFreeform} from '../_lib/freeform/materializer.js';
import {aiProvider,workersAiModels} from '../_lib/workers-ai.js';

export async function runFreeform({entries,filename,locale,env}){
  const {lossless,ai,diagnostics}=await buildFreeformArchive(entries,{filename});
  console.log('Freeform archive:',diagnostics.files,'files',diagnostics.rows,'rows',diagnostics.archive_lossless_chars,'chars');
  console.log('Freeform model context:',diagnostics.archive_model_chars,'chars; duplicate entity index omitted');
  console.log('Reviews included:',`${diagnostics.reviews}/${diagnostics.reviews}`,'Lists:',`${diagnostics.lists}/${diagnostics.lists}`,'Unknown files:',`${diagnostics.unknown_files}/${diagnostics.unknown_files}`);
  const judgment=await freeformJudge({archive:ai,locale,env});
  console.log('Freeform Judge:',judgment._model,judgment.moments.length,'moments',judgment.games.length,'games',judgment._finish_reason||'');
  return materializeFreeform({archive:ai,judgment,locale,provider:aiProvider(env),primaryModel:workersAiModels(env)[0],diagnostics:{...diagnostics,lossless_available_during_request:true}});
}
