import {archiveRefs} from './archive-json.js';

const clean=value=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,500);
const segments=text=>[{text:clean(text),effect:'none'}];
const message=(text,extra={})=>({type:'message',segments:segments(text),...extra});
const typing=(duration='short')=>({type:'typing',duration});
const pause=(duration='medium')=>({type:'pause',duration});
const firstObject=(archive,path)=>{const file=(archive.files||[]).find(row=>row.path.toLowerCase()===path);if(!file?.rows?.length)return {};const headers=file.headers||file.rows[0]?.cells||[];const data=file.rows.slice(1).find(row=>row.cells?.some(Boolean));return data?Object.fromEntries(headers.map((header,index)=>[header,data.cells[index]??''])):{};};
const profileInfo=archive=>{const row=firstObject(archive,'profile.csv');return {handle:row.Username||'',name:row.Name||row.Username||''};};
const topFour=archive=>{
  const row=firstObject(archive,'profile.csv'),refs=String(row['Favorite Films']||'').split(',').map(value=>value.trim()).filter(Boolean).slice(0,4),films=[];
  for(const ref of refs){let found=null;for(const file of archive.files||[]){if(file.format!=='csv')continue;const headers=file.headers||[];for(const data of (file.rows||[]).slice(1)){const object=Object.fromEntries(headers.map((header,index)=>[header,data.cells[index]??''])),uris=[object['Letterboxd URI'],object.URL].filter(Boolean).map(value=>value.replace(/\/$/,''));if(uris.includes(ref.replace(/\/$/,''))&&object.Name){found={title:object.Name,year:object.Year||null,film_key:`${object.Name}|${object.Year||''}`};break;}}if(found)break;}films.push(found||{title:ref,year:null,film_key:ref});}
  return films;
};
const stats=archive=>[{label:'Arquivos',value:archive.archive?.file_count||0},{label:'Reviews',value:archive.archive?.reviews||0},{label:'Linhas',value:archive.archive?.row_count||0}];

export function materializeFreeform({archive,judgment,locale='pt-BR',diagnostics={}}){
  const pt=locale==='pt-BR',events=[],beats=[],opening=judgment.opening||{},profile=profileInfo(archive),favorites=topFour(archive),registry=archiveRefs(archive);
  for(const line of opening.greeting||[pt?'Certo.':'Right.'])events.push(typing('medium'),message(line));
  if(favorites.length){events.push(typing('long'),message(opening.archetype_lead||(pt?'Você deve ser o...':'You must be the...'),{cue:'top_four_reveal'}));if(opening.archetype_phrase)events.push(message(opening.archetype_phrase,{role:'archetype_phrase'}));for(const line of opening.archetype_after||[])events.push(pause(),message(line));if(opening.username_line)events.push(message(opening.username_line));}
  const taste=opening.taste_bit||{};if(taste.lead)events.push(typing(),message(taste.lead));if(taste.strike)events.push({type:'strike',text:clean(taste.strike)});if(taste.correction)events.push({type:'correction',original:clean(taste.strike),replacement:clean(taste.correction)});if(taste.tail)events.push(message(taste.tail));if(opening.judge_claim)events.push(message(opening.judge_claim));for(const line of opening.transition||[])events.push(typing(),message(line));
  events.push({type:'profile_stats',stats:stats(archive)});
  const games=[...judgment.games];let gameIndex=0;
  for(const [index,moment] of judgment.moments.entries()){
    const start=events.length,evidence=moment.evidence_refs.map(ref=>{const hit=registry.get(ref);return {ref,path:hit?.file?.path||'',cells:hit?.row?.cells||null};});
    events.push(pause('medium'),{type:'custom_attachment',title:moment.title||moment.type,label:moment.display_text||moment.display?.label||'',values:moment.display?.values||[],films:moment.display?.films||[],evidence_refs:moment.evidence_refs,evidence},pause('long'));
    for(const line of moment.lines)events.push(typing('short'),message(line));
    beats.push({beat_id:moment.id,moment_id:moment.id,moment_type:moment.type,origin:'freeform',finding_ids:moment.evidence_refs,render_strategy:moment.lines.length?'ai':'silence',source:'freeform_judge',writer_mode:'freeform',status:moment.lines.length?'written':'silent',lines:moment.lines.flatMap(segments),event_count:events.length-start});
    const insert=games[gameIndex]&&(index===Math.min(2,judgment.moments.length-1)||(gameIndex===1&&index===Math.max(4,judgment.moments.length-2)));
    if(insert){const game=games[gameIndex++],copy=game.copy||{};events.push(typing(),{type:'game_intro',game_id:game.id,segments:segments(copy.intro||(pt?'Espera. Preciso testar uma coisa.':'Wait. I need to test something.'))},{type:game.type==='forced_triage'?'game_forced_triage':game.type==='blind_rank'?'game_blind_rank':'game_defend_take',game_id:game.id,films:game.films,difficulty:game.difficulty||'hard',copy});}
  }
  for(;gameIndex<games.length;gameIndex++){const game=games[gameIndex],copy=game.copy||{};events.push({type:'game_intro',game_id:game.id,segments:segments(copy.intro||'Espera.')},{type:game.type==='forced_triage'?'game_forced_triage':game.type==='blind_rank'?'game_blind_rank':'game_defend_take',game_id:game.id,films:game.films,difficulty:game.difficulty||'hard',copy});}
  for(const line of judgment.closer)events.push(typing('medium'),message(line,{role:'closer'}));
  const summary=pt?`Modo experimental livre. O conteúdo completo dos ${archive.archive.file_count} arquivos do export foi convertido em JSON e enviado ao modelo. O backend não pré-selecionou pautas.`:`Experimental freeform mode. All ${archive.archive.file_count} export files were converted to JSON and sent to the model. The backend did not preselect topics.`;
  return {version:'presentation-v2',template:'web_opening_v2',pipeline_mode:'freeform',locale,profile:{name:profile.name,handle:profile.handle,display_name:profile.name},stats:stats(archive),opening:{top_four:favorites,archetype_text:clean(opening.archetype_phrase),top_four_archetype:{requested:favorites.length===4,phrase:clean(opening.archetype_phrase),valid:Boolean(opening.archetype_phrase)}},profile_review:judgment.profile_review,explainability:{mode:'freeform',summary,files_processed:archive.archive.file_count,evidence:judgment.moments.map(moment=>({moment:moment.id,evidence_refs:moment.evidence_refs})),models:{freeform_judge:{served_model:judgment._model,status:'complete',context_chars:judgment._request_chars}},archive:diagnostics},render:{ai_generation:'complete',model:'gemini',served_model:judgment._model,model_quality:/lite/i.test(judgment._model)?'fallback_lite':'primary',runtime:'cloudflare-pages'},ai:{origin:'api',attempts:judgment._attempts,warnings:judgment.invalid,calls:judgment._main_calls+(judgment._repair_calls||0)},generation_meta:{pipeline:'freeform',freeform_judge:{model:judgment._model,main_calls:judgment._main_calls,repair_calls:judgment._repair_calls||0}},beats,events};
}
