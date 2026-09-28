const allowedLine=value=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,220);
// The model is told not to write markup, but a quote copied from an export may still
// arrive wrapped. Only `blockquote` becomes a segment; every other tag is dropped and
// its text stays inline, so nothing is ever printed as a literal tag.
function markupParts(value) {
  const input=String(value||''),parts=[],stack=[];let cursor=0;
  const push=chunk=>{if(!chunk)return;const type=stack.length?'blockquote':'text',text=chunk.replace(/\s+/g,' ');if(!text)return;const previous=parts.at(-1);if(previous?.type===type)previous.text+=text;else parts.push({type,text});};
  for(const match of input.matchAll(/<\/?\s*([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g)){
    push(input.slice(cursor,match.index));cursor=match.index+match[0].length;
    const closing=match[0][1]==='/',name=match[1].toLowerCase();
    if(name==='br'){push(' ');continue;}
    if(name!=='blockquote')continue;
    if(closing){const at=stack.lastIndexOf('blockquote');if(at>=0)stack.splice(at);}else stack.push('blockquote');
  }
  push(input.slice(cursor));
  return parts.map(part=>({...part,text:part.text.trim()})).filter(part=>part.text);
}
const lineSegments=(text,effect='none')=>{const rows=markupParts(text).map(part=>({text:allowedLine(part.text),effect:part.type==='blockquote'?'quote':effect})).filter(row=>row.text);return rows.length?rows:[{text:allowedLine(String(text||'').replace(/<[^>]*>/g,' ')),effect}];};
const message=(text,extra={})=>({type:'message',segments:lineSegments(text),...extra});
const strikeMessage=(text)=>({type:'strike',text:allowedLine(text)});
const correction=(original,replacement)=>({type:'correction',original:allowedLine(original),replacement:allowedLine(replacement)});
const typing=(duration='short')=>({type:'typing',duration});
const pause=(duration='short')=>({type:'pause',duration});

function dataEvents(moment) {
  switch(moment.type){
    case 'film_pair':return [{type:'film_pair',films:moment.films}];
    case 'rewatch':return [{type:'rewatch',film:moment.film,sessions:moment.sessions.map(({date,rating,index})=>({date,rating,index})),stats:moment.stats}];
    case 'tag':return [{type:'tag',tag:moment.tag,related_tag:'',films:moment.films,stats:moment.stats}];
    case 'tag_list_relationship':return [{type:'tag_list_relationship',tag:{name:moment.tag},list:{name:moment.list?.name||moment.relationship?.list||'',description:moment.list?.description||''},intersection:moment.relationship?.intersection||moment.shared_films?.length||0,list_count:moment.relationship?.list_count||moment.list?.count||0,tag_count:moment.relationship?.tag_count||0,coverage:moment.relationship?.coverage_list??moment.relationship?.coverage??null,lift:moment.relationship?.lift??null,shared_films:moment.shared_films||[],exceptions:moment.exceptions||{list_without_tag:[],tag_without_list:[]}}];
    case 'tag_tag_relationship':return [{type:'tag_tag_relationship',left:{name:moment.left},right:{name:moment.right},intersection:moment.relationship?.intersection||0,lift:moment.relationship?.lift??null,shared_films:moment.films||[],exceptions:{left_without_right:moment.relationship?.left_without_right||[],right_without_left:moment.relationship?.right_without_left||[]}}];
    case 'list_list_relationship':return [{type:'list_list_relationship',left:{name:moment.left},right:{name:moment.right},intersection:moment.relationship?.intersection||0,lift:moment.relationship?.lift??null,shared_films:moment.films||[],exceptions:{left_without_right:moment.relationship?.left_without_right||[],right_without_left:moment.relationship?.right_without_left||[]}}];
    case 'list':return [{type:'list',name:moment.name,description:moment.description,films:moment.films.slice(0,4),count:moment.count,stats:moment.stats}];
    case 'phrase':return [{type:'phrase',phrase:moment.phrase,stats:moment.stats},...moment.examples.map(review=>({type:'review_quote',film_key:review.film_key,title:review.title,year:review.year,rating:review.rating,text:review.text,segments:review.segments}))];
    case 'stat':return [{type:'stat',stats:moment.stats}];

    case 'review_quote':{const review=moment.review;return [{type:'review_quote',film_key:review.film_key,title:review.title,year:review.year,rating:review.rating,text:review.text,segments:review.segments}];}
    default:return [];
  }
}

function gameEvents(game,copy,profile,locale){
  const pt=locale==='pt-BR',byKey=new Map(profile.films.map(f=>[f.film_key,f])),sessions=profile.sessions||[];
  const films=(game.film_keys||[]).map(key=>byKey.get(key)).filter(Boolean);
  const hiddenFilms=films.map(({film_key,title,year})=>({film_key,title,year}));
  const history=films.map(film=>({film_key:film.film_key,title:film.title,year:film.year,rating:film.rating??null,rewatches:Math.max(0,sessions.filter(s=>s.film_key===film.film_key).length-1)}));
  const common={game_id:game.id,game_type:game.type,skip_label:pt?'Pular':'Skip'};
  const intro={type:'game_intro',...common,text:copy?.intro||(pt?'Espera. Preciso testar uma coisa.':'Wait. I need to test something.')};
  if(game.type==='forced_triage')return [intro,{type:'game_forced_triage',...common,films:hiddenFilms,roles:copy?.roles||[],confirm_label:copy?.confirm_label||(pt?'Confirmar':'Confirm')},{type:'game_result',...common,history,result_reactions:copy?.result_reactions||{}}];
  if(game.type==='blind_rank')return [intro,{type:'game_blind_rank',...common,films:hiddenFilms,instructions:copy?.instructions||'',confirm_label:copy?.confirm_label||(pt?'Fechar ranking':'Lock ranking')},{type:'game_result',...common,history,reveal_copy:copy?.reveal_copy||'',result_reactions:copy?.result_reactions||{}}];
  if(game.type==='defend_your_take')return [intro,{type:'game_defend_take',...common,film:hiddenFilms[0]||null,question:copy?.question||'',choices:copy?.choices||[],tmdb:game.tmdb||null},{type:'game_result',...common,history,reveal_copy:copy?.reveal_copy||'',result_reactions:copy?.result_reactions||{}}];
  return [];
}
function gamePositions(count,games){
  const positions=new Map();if(!games?.length||count<2)return positions;
  const first=Math.min(Math.max(2,Math.floor(count*.35)),Math.max(2,count-1));positions.set(first,[games[0]]);
  if(games[1]){const second=Math.min(count-1,Math.max(first+2,Math.floor(count*.75)));const rows=positions.get(second)||[];rows.push(games[1]);positions.set(second,rows);}
  return positions;
}

export function buildPresentation({profile,analysis,writing,locale,analyst={}}) {
  const pt=locale==='pt-BR',topFour=profile.topFour.map(({film_key,title,year,rating})=>({film_key,title,year,rating})),opening=writing.opening||{};
  const events=[];for(const line of opening.greeting?.length?opening.greeting:[writing.greeting||(pt?'Certo.':'Right.')])events.push(typing('medium'),message(line));
  if(topFour.length){
    events.push(typing('long'),message(opening.archetype_lead||(pt?'Você deve ser o...':'You must be the...'),{cue:'top_four_reveal'}));
    if(topFour.length===4&&allowedLine(opening.archetype_phrase||writing.archetype_phrase)){events.push(message(opening.archetype_phrase||writing.archetype_phrase,{role:'archetype_phrase'}));for(const line of opening.archetype_after?.length?opening.archetype_after:['...?',pt?'Grande demais.':'Way too long.'])events.push(pause('medium'),message(line));}
    else events.push(pause('short'),message('...'),pause('short'),message(pt?'Tá, deixa pra lá.':'Actually, never mind.'));
    events.push(message(opening.username_line||(profile.handle?(pt?`Pode ser só ${profile.handle}.`:`Let's just call you ${profile.handle}.`):(pt?'Vou ficar com um nome mais simples.':"I'll stick with something simpler."))));
  }
  const taste=opening.taste_bit||{};if(taste.enabled!==false){events.push(typing('short'),message(taste.lead||(pt?'Me falaram que você tem um':'They told me you have a')));if(taste.strike&&taste.correction)events.push(strikeMessage(taste.strike),pause('short'),correction(taste.strike,taste.correction));if(taste.tail)events.push(message(taste.tail));}
  for(const line of opening.transition?.length?opening.transition:[pt?'Deixa eu ver.':'Let me take a look.'])events.push(typing('medium'),message(line));
  events.push(typing('medium'),message('...!'),{type:'profile_stats',stats:analysis.stats});
  if(allowedLine(writing.profile_reaction))events.push(typing('short'),message(writing.profile_reaction));
  const duration=(value,fallback)=>['short','medium','long'].includes(value)?value:fallback;
  const reactions=new Map((Array.isArray(writing.reactions)?writing.reactions:[]).filter(row=>row&&typeof row.id==='string'&&Array.isArray(row.lines)).map(row=>[row.id,{lines:row.lines.map(allowedLine).filter(Boolean).slice(0,4),afterBeat:(row.after_beat||[]).map(allowedLine).filter(Boolean).slice(0,2),evidencePause:duration(row.evidence_pause,'medium'),afterEvidence:duration(row.after_evidence,'long'),typing:duration(row.typing,'short'),between:duration(row.between_lines,'medium'),after:duration(row.after_reaction,'medium')} ]));
  const gameCopy=new Map((writing.game_copy||[]).map(row=>[row.id,row])),selectedGames=analysis.selected_interactions||[],positions=gamePositions(analysis.moments.length,selectedGames);
  const beats=[];
  for(const [momentIndex,moment] of analysis.moments.entries()){
    const block=dataEvents(moment),reaction=reactions.get(moment.id)||{lines:[],afterBeat:[],evidencePause:'medium',afterEvidence:'long',typing:'short',between:'medium',after:'medium'};
    const start=events.length;events.push(pause(reaction.evidencePause),...block,pause(reaction.afterEvidence));
    if(reaction.lines.length){events.push(typing(reaction.typing));reaction.lines.forEach((line,index)=>{events.push(message(line));if(index<reaction.lines.length-1)events.push(pause(reaction.between));});events.push(pause(reaction.after));}for(const line of reaction.afterBeat)events.push(typing('short'),message(line));
    beats.push({beat_id:moment.id,moment_id:moment.id,moment_type:moment.type,origin:'web',finding_ids:[moment.id],render_strategy:reaction.lines.length?'ai':'silence',source:'pages_function',writer_mode:'short_reaction',status:reaction.lines.length?'written':'silent',lines:reaction.lines.flatMap(text=>lineSegments(text)),event_count:events.length-start});
    for(const game of positions.get(momentIndex+1)||[])events.push(pause('medium'),...gameEvents(game,gameCopy.get(game.id),profile,locale),pause('medium'));
  }
  for(const line of writing.closer||[])events.push(typing('medium'),message(line,{role:'closer'}));
  const interestingFindings=(analyst.selected||[]).slice(0,8).map(row=>({observation:row.observation||'',why_interesting:row.why_interesting||''})).filter(row=>row.observation),findings=interestingFindings.map(row=>[row.observation,row.why_interesting].filter(Boolean).join(' — '));
  const summary=pt?`O export continha ${profile.inventory?.files_in_zip||profile.inventory?.files_processed||0} arquivos (${profile.inventory?.files_processed||0} ativos, ${analysis.moments.length} pautas no roteiro). Foram medidos ${analysis.overview.watched} filmes, ${analysis.overview.reviews} reviews, ${analysis.overview.rewatches} reassistidas e ${analysis.overview.tags||0} tags.`:`The export contained ${profile.inventory?.files_processed||0} files. It measured ${analysis.overview.watched} films, ${analysis.overview.reviews} reviews, ${analysis.overview.rewatches} rewatches and ${analysis.overview.tags||0} tags.`;
  const archetypeText=allowedLine(opening.archetype_phrase||writing.archetype_phrase);const profileReview=writing.profile_review?{...writing.profile_review,text:writing.profile_review.full||writing.profile_review.text||'',full:writing.profile_review.full||writing.profile_review.text||'',share:writing.profile_review.share||writing.profile_review.full||writing.profile_review.text||''}:null;
  return {version:'presentation-v2',template:'web_opening_v2',locale,profile:{name:profile.name,handle:profile.handle,display_name:profile.name},stats:analysis.stats,opening:{top_four:topFour,salutation:opening.greeting||[writing.greeting||''],adjective_pair:{negative:taste.strike||'',positive:taste.correction||''},archetype:[],archetype_text:archetypeText,top_four_archetype:{requested:topFour.length===4,concepts:[],phrase:archetypeText,valid:topFour.length===4&&Boolean(archetypeText),repaired:false,fallback_used:false,issues:[]},profile_reaction:allowedLine(writing.profile_reaction)?[{text:allowedLine(writing.profile_reaction),effect:'none'}]:[]},profile_review:profileReview,editorial_quality:analysis.editorial_quality||null,explainability:{summary,findings,files_processed:profile.inventory?.files_processed||0,files_in_zip:profile.inventory?.files_in_zip||profile.inventory?.files_processed||0,profile_summary:analysis.overview,measurements:analysis.stats,analyst:{candidates_found:analyst.candidate_count||0,selected:analysis.moments.length},interesting_findings:interestingFindings,writer:{model:writing._model||null,status:writing._degraded?'partial':'complete'},games:{selected:(analysis.selected_interactions||[]).map(game=>({type:game.type,difficulty:game.difficulty_score??game.difficulty,reason:game.difficulty_reason||game.why_difficult}))}},render:{ai_generation:writing._degraded?'partial':'complete',model:'gemini',served_model:writing._model||'gemini',quality_degraded:Boolean(writing._degraded),salvaged:Boolean(writing._salvaged),human_templates:false,runtime:'cloudflare-pages'},ai:{origin:'api',attempts:writing._attempts||[],warnings:writing._warnings||[],calls:(writing._attempts?.length||1)+(analyst.attempts?.length||0)},generation_meta:{analyst:{status:analyst.status||'unknown',model:analyst.model||null,candidate_count:analyst.candidate_count||0},writer:{status:writing._degraded?'partial':'complete',model:writing._model||null,reactions:reactions.size}},beats,events};
}
