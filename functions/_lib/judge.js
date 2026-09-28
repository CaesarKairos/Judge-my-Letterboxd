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
    case 'list':return [{type:'list',name:moment.name,description:moment.description,films:moment.films.slice(0,4),count:moment.count,stats:moment.stats}];
    case 'phrase':return [{type:'phrase',phrase:moment.phrase,stats:moment.stats},...moment.examples.map(review=>({type:'review_quote',film_key:review.film_key,title:review.title,year:review.year,rating:review.rating,text:review.text,segments:review.segments}))];
    case 'stat':return [{type:'stat',stats:moment.stats}];

    case 'review_quote':{const review=moment.review;return [{type:'review_quote',film_key:review.film_key,title:review.title,year:review.year,rating:review.rating,text:review.text,segments:review.segments}];}
    default:return [];
  }
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
  const beats=[];
  for(const moment of analysis.moments){
    const block=dataEvents(moment),reaction=reactions.get(moment.id)||{lines:[],afterBeat:[],evidencePause:'medium',afterEvidence:'long',typing:'short',between:'medium',after:'medium'};
    const start=events.length;events.push(pause(reaction.evidencePause),...block,pause(reaction.afterEvidence));
    if(reaction.lines.length){events.push(typing(reaction.typing));reaction.lines.forEach((line,index)=>{events.push(message(line));if(index<reaction.lines.length-1)events.push(pause(reaction.between));});events.push(pause(reaction.after));}for(const line of reaction.afterBeat)events.push(typing('short'),message(line));
    beats.push({beat_id:moment.id,moment_id:moment.id,moment_type:moment.type,origin:'web',finding_ids:[moment.id],render_strategy:reaction.lines.length?'ai':'silence',source:'pages_function',writer_mode:'short_reaction',status:reaction.lines.length?'written':'silent',lines:reaction.lines.flatMap(text=>lineSegments(text)),event_count:events.length-start});
  }
  for(const line of writing.closer||[])events.push(typing('medium'),message(line,{role:'closer'}));
  const interestingFindings=(analyst.selected||[]).slice(0,8).map(row=>({observation:row.observation||'',why_interesting:row.why_interesting||''})).filter(row=>row.observation),findings=interestingFindings.map(row=>[row.observation,row.why_interesting].filter(Boolean).join(' — '));
  const summary=pt?`O export continha ${profile.inventory?.files_in_zip||profile.inventory?.files_processed||0} arquivos (${profile.inventory?.files_processed||0} ativos, ${analysis.moments.length} pautas no roteiro). Foram medidos ${analysis.overview.watched} filmes, ${analysis.overview.reviews} reviews, ${analysis.overview.rewatches} reassistidas e ${analysis.overview.tags||0} tags.`:`The export contained ${profile.inventory?.files_processed||0} files. It measured ${analysis.overview.watched} films, ${analysis.overview.reviews} reviews, ${analysis.overview.rewatches} rewatches and ${analysis.overview.tags||0} tags.`;
  const archetypeText=allowedLine(opening.archetype_phrase||writing.archetype_phrase);
  return {version:'presentation-v2',template:'web_opening_v2',locale,profile:{name:profile.name,handle:profile.handle,display_name:profile.name},stats:analysis.stats,opening:{top_four:topFour,salutation:opening.greeting||[writing.greeting||''],adjective_pair:{negative:taste.strike||'',positive:taste.correction||''},archetype:[],archetype_text:archetypeText,top_four_archetype:{requested:topFour.length===4,concepts:[],phrase:archetypeText,valid:topFour.length===4&&Boolean(archetypeText),repaired:false,fallback_used:false,issues:[]},profile_reaction:allowedLine(writing.profile_reaction)?[{text:allowedLine(writing.profile_reaction),effect:'none'}]:[]},profile_review:writing.profile_review||null,explainability:{summary,findings,files_processed:profile.inventory?.files_processed||0,files_in_zip:profile.inventory?.files_in_zip||profile.inventory?.files_processed||0,profile_summary:analysis.overview,measurements:analysis.stats,analyst:{candidates_found:analyst.candidate_count||0,selected:analysis.moments.length},interesting_findings:interestingFindings,writer:{model:writing._model||null,status:writing._degraded?'partial':'complete'}},render:{ai_generation:writing._degraded?'partial':'complete',model:'gemini',served_model:writing._model||'gemini',quality_degraded:Boolean(writing._degraded),salvaged:Boolean(writing._salvaged),human_templates:false,runtime:'cloudflare-pages'},ai:{origin:'api',attempts:writing._attempts||[],warnings:writing._warnings||[],calls:(writing._attempts?.length||1)+(analyst.attempts?.length||0)},generation_meta:{analyst:{status:analyst.status||'unknown',model:analyst.model||null,candidate_count:analyst.candidate_count||0},writer:{status:writing._degraded?'partial':'complete',model:writing._model||null,reactions:reactions.size}},beats,events};
}
