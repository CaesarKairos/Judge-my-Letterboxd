const allowedLine=value=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,220);
const message=(text,extra={})=>({type:'message',segments:[{text:allowedLine(text),effect:'none'}],...extra});
const typing=(duration='short')=>({type:'typing',duration});
const pause=(duration='short')=>({type:'pause',duration});

function dataEvents(moment) {
  switch(moment.type){
    case 'film_pair':return [{type:'film_pair',films:moment.films}];
    case 'rewatch':return [{type:'rewatch',film:moment.film,sessions:moment.sessions.map(({date,rating,index})=>({date,rating,index})),stats:moment.stats}];
    case 'tag':return [{type:'tag',tag:moment.tag,related_tag:'',films:moment.films,stats:moment.stats}];
    case 'list':return [{type:'list',name:moment.name,description:moment.description,films:moment.films.slice(0,4),count:moment.count,stats:moment.stats}];
    case 'phrase':return [{type:'phrase',phrase:moment.phrase,stats:moment.stats},...moment.examples.map(review=>({type:'review_quote',film_key:review.film_key,title:review.title,year:review.year,rating:review.rating,text:review.text,segments:[{type:'text',text:review.text}]}))];
    case 'review_quote':{const review=moment.review;return [{type:'review_quote',film_key:review.film_key,title:review.title,year:review.year,rating:review.rating,text:review.text,segments:[{type:'text',text:review.text}]}];}
    default:return [];
  }
}

export function buildPresentation({profile,analysis,writing,locale}) {
  const pt=locale==='pt-BR',topFour=profile.topFour.map(({film_key,title,year,rating})=>({film_key,title,year,rating}));
  const events=[typing('medium'),message(writing.greeting|| (pt?'Certo.':'Right.'))];
  if(topFour.length){
    events.push(typing('long'),message(pt?'Você deve ser o...':'You must be the...',{cue:'top_four_reveal'}));
    if(topFour.length===4&&allowedLine(writing.archetype_phrase))events.push(message(writing.archetype_phrase,{role:'archetype_phrase'}),pause('medium'),message('...?'),pause('medium'),message(pt?'Grande demais.':'Way too long.'));
    else events.push(pause('short'),message('...'),pause('short'),message(pt?'Tá, deixa pra lá.':'Actually, never mind.'));
    events.push(message(profile.handle?(pt?`Pode ser só ${profile.handle}.`:`Let's just call you ${profile.handle}.`):(pt?'Vou ficar com um nome mais simples.':"I'll stick with something simpler.")));
  }
  events.push(typing('short'),message(pt?'Me falaram que você tem um':'They told me you have a'),{type:'strike',text:pt?'questionável':'questionable'},pause('short'),{type:'correction',original:pt?'questionável':'questionable',replacement:pt?'excelente':'excellent'},message(pt?' gosto pra filmes.':' taste in movies.'),message(pt?'Mas fala sério.':'But seriously.'),message(pt?'Só quem pode julgar isso sou eu.':'Only I get to judge this.'),typing('medium'),message(pt?'Deixa eu ver.':'Let me take a look.'),typing('medium'),message('...!'),{type:'profile_stats',stats:analysis.stats});
  if(allowedLine(writing.profile_reaction))events.push(typing('short'),message(writing.profile_reaction));
  const reactions=new Map(writing.reactions.filter(row=>row&&typeof row.id==='string'&&Array.isArray(row.lines)).map(row=>[row.id,row.lines.map(allowedLine).filter(Boolean).slice(0,3)]));
  const beats=[];
  for(const moment of analysis.moments){
    const block=dataEvents(moment),lines=reactions.get(moment.id)||[];events.push(...block);
    if(lines.length)events.push(typing('short'),...lines.map(line=>message(line)));else events.push(pause('short'));
    beats.push({beat_id:moment.id,moment_id:moment.id,moment_type:moment.type,origin:'web',finding_ids:[moment.id],render_strategy:lines.length?'ai':'silence',source:'pages_function',writer_mode:'short_reaction',status:lines.length?'written':'silent',lines:lines.map(text=>({text,effect:'none'})),event_count:block.length+(lines.length?lines.length+1:1)});
  }
  return {version:'presentation-v1',template:'web_opening_v1',locale,profile:{name:profile.name,handle:profile.handle,display_name:profile.name},stats:analysis.stats,opening:{top_four:topFour,salutation:writing.greeting||'',adjective_pair:{negative:pt?'questionável':'questionable',positive:pt?'excelente':'excellent'},archetype:[],archetype_text:allowedLine(writing.archetype_phrase),top_four_archetype:{requested:topFour.length===4,concepts:[],phrase:allowedLine(writing.archetype_phrase),valid:topFour.length===4&&Boolean(allowedLine(writing.archetype_phrase)),repaired:false,fallback_used:false,issues:[]},profile_reaction:allowedLine(writing.profile_reaction)?[{text:allowedLine(writing.profile_reaction),effect:'none'}]:[]},render:{ai_generation:'complete',model:'gemini',served_model:writing._model||'gemini',quality_degraded:false,human_templates:false,runtime:'cloudflare-pages'},ai:{origin:'api',attempts:writing._attempts||[],warnings:[],calls:writing._attempts?.length||1},beats,events};
}
