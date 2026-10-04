import {buildFreeformRegistry} from './references.js';
const EFFECTS=new Set(['normal','italic','bold','strike','correction','quote','wave','shake','muted','green','blue','orange']),rich=value=>{if(typeof value==='string')return value.trim();const runs=(Array.isArray(value?.runs)?value.runs:[]).map(run=>({text:String(run?.text||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,500),effect:EFFECTS.has(run?.effect)?run.effect:'normal'})).filter(run=>run.text);return runs.length?{kind:value?.kind==='blockquote'?'blockquote':'text',runs}:'';},richText=value=>typeof value==='string'?value:(Array.isArray(value?.runs)?value.runs.map(run=>run?.text||'').join(''):''),clean=value=>String(richText(value)||'').replace(/\s+/g,' ').trim(),refsOf=value=>(Array.isArray(value)?value:[]).map(clean).filter(Boolean),linesOf=value=>(Array.isArray(value)?value:[]).map(rich).filter(Boolean).slice(0,5);
const ATTACHMENTS=new Set(['film','film_pair','film_group','review_quote','tag','list','phrase','stat','rewatch','relationship','custom']);
const profileData=archive=>{const file=(archive.files||[]).find(row=>row.path.toLowerCase()==='profile.csv'),headers=file?.headers||[],row=file?.rows?.[1]?.cells||[];return Object.fromEntries(headers.map((key,index)=>[key,row[index]??'']));};
export function validArchetype(value,{handle='',titles=[]}={}){const phrase=clean(value),words=phrase.split(/\s+/).filter(Boolean),lower=phrase.toLowerCase();return Boolean(phrase)&&words.length>=3&&words.length<=12&&phrase.length<=100&&(!handle||!lower.includes(clean(handle).toLowerCase()))&&titles.filter(title=>title&&lower.includes(clean(title).toLowerCase())).length<3&&!/^(cinéfilo|cinefilo|amante de cinema|film bro|pessoa que gosta de filmes)$/i.test(phrase)&&!/\b(bio|perfil|letterboxd|usuário|usuario)\b/i.test(phrase);}
// Turns one attachment into the shape the materializer accepts, or null when it cannot be shown.
// An unresolved attachment is dropped on its own; it never takes the moment down with it.
function materialAttachment(row,registry){
  if(!row||!ATTACHMENTS.has(row.type))return null;
  if(row.type==='film')return registry.films[row.film_id]?{type:'film',film_id:row.film_id}:null;
  if(['film_pair','film_group'].includes(row.type)){const ids=(Array.isArray(row.film_ids)?row.film_ids:[]).filter(id=>registry.films[id]);return ids.length>=(row.type==='film_pair'?2:1)?{type:row.type,film_ids:ids}:null;}
  if(row.type==='review_quote')return registry.reviews[row.review_ref]?{type:'review_quote',review_ref:row.review_ref}:null;
  if(row.type==='list'){const id=registry.listIdFor(row.list_id)||registry.listIdFor(row.list_ref);return id?{type:'list',list_id:id}:null;}
  if(row.type==='tag'){const id=registry.tagIdFor(row.tag_id)||registry.tagIdFor(row.tag);return id?{type:'tag',tag_id:id}:null;}
  if(row.type==='rewatch'){const refs=(Array.isArray(row.session_refs)?row.session_refs:[]).filter(ref=>registry.sessions[ref]);return refs.length?{type:'rewatch',session_refs:refs}:null;}
  return {...row};
}
export function validateFreeformResponse(payload,archive,{registry=buildFreeformRegistry(archive)}={}){
  const invalid=[],moments=[],moments_invalid=[],attachments_invalid=[];
  let moments_received=0,attachments_valid=0,refs_dropped=0;
  for(const [index,row] of (Array.isArray(payload?.moments)?payload.moments:[]).slice(0,20).entries()){
    moments_received++;
    if(!row||typeof row!=='object'){const record={index,id:null,reason:'not_an_object'};moments_invalid.push(record);invalid.push({kind:'moment',...record});continue;}
    const evidence=registry.normalizeRefs(refsOf(row.evidence_refs)),kept=[];
    for(const [attachment_index,item] of (Array.isArray(row.attachments)?row.attachments:[]).entries()){
      const built=materialAttachment(item,registry);
      if(built){kept.push(built);attachments_valid++;}
      else{const record={moment_index:index,attachment_index,type:clean(item?.type)||'unknown',reason:'unresolved_attachment'};attachments_invalid.push(record);invalid.push({kind:'attachment',...record});}
    }
    // A moment survives when anything it claims is real: a valid ref or a valid attachment.
    if(!evidence.refs.length&&!kept.length){const record={index,id:clean(row.id)||null,reason:evidence.invalid.length?'unresolved_evidence_refs':'empty_evidence',invalid_refs:evidence.invalid};moments_invalid.push(record);invalid.push({kind:'moment',...record});continue;}
    moments.push({id:clean(row.id)||`moment_${String(index+1).padStart(2,'0')}`,type:clean(row.type)||'custom',label:clean(row.label).slice(0,60),attachments:kept,lines:linesOf(row.lines),evidence_refs:evidence.refs});
    if(evidence.invalid.length){refs_dropped+=evidence.invalid.length;invalid.push({kind:'moment',index,id:clean(row.id)||null,reason:'dropped_invalid_refs',invalid_refs:evidence.invalid});}
  }
  const ratedFilms=Object.values(registry.films).filter(film=>Number.isFinite(Number(film.current_rating))),required_games=ratedFilms.length>=6?2:0,games=[],games_invalid=[];
  let games_received=0;
  for(const [index,row] of (Array.isArray(payload?.games)?payload.games:[]).slice(0,2).entries()){
    games_received++;
    const type=clean(row?.type),typeValid=['forced_triage','blind_rank','defend_your_take'].includes(type);
    const film_ids=(Array.isArray(row?.film_ids)?row.film_ids:[]).map(id=>registry.filmIdFor(id)||clean(id)).slice(0,3);
    const filmsValid=film_ids.length===3&&new Set(film_ids).size===3&&film_ids.every(id=>registry.films[id]);
    const evidence=registry.normalizeRefs(refsOf(row?.evidence_refs)),copy=row?.copy||{},roles=Array.isArray(copy.roles)?copy.roles:[],hints=Array.isArray(copy.reaction_hints)?copy.reaction_hints:[];
    const copyValid=Boolean(clean(copy.intro))&&(type!=='forced_triage'||(roles.length===3&&new Set(roles.map(role=>role.id)).size===3&&roles.every(role=>clean(role.label)&&Number.isFinite(Number(role.rank)))&&hints.length>0));
    if(!row||!typeValid||!filmsValid||!copyValid){const record={index,id:clean(row?.id)||null,reason:!filmsValid?'unresolved_film':!copyValid?'invalid_copy':'invalid_type'};games_invalid.push(record);invalid.push({kind:'game',...record});continue;}
    // The three films and the copy are real, so the game is kept; a bad evidence_ref only needs a repair.
    const fallback=registry.canonical(registry.films[film_ids[0]]);
    games.push({...row,id:clean(row.id)||`game_${index+1}`,type,film_ids,evidence_refs:evidence.refs.length?evidence.refs:[fallback].filter(Boolean),copy});
    if(evidence.invalid.length){refs_dropped+=evidence.invalid.length;invalid.push({kind:'game',index,id:clean(row.id)||null,reason:'dropped_invalid_refs',invalid_refs:evidence.invalid});}
  }
  if(games.length===2&&clean(games[0].copy.intro).toLowerCase()===clean(games[1].copy.intro).toLowerCase()){invalid.push({kind:'game',index:1,id:games[1].id,reason:'duplicate_intro'});games.pop();}
  const info=profileData(archive),handle=clean(info.Username),favoriteRefs=String(info['Favorite Films']||'').split(',').map(v=>v.trim().replace(/\/$/,'')).filter(Boolean).slice(0,4),favoriteTitles=favoriteRefs.map(ref=>Object.values(registry.films).find(film=>String(film.uri||'').replace(/\/$/,'')===ref)?.title||ref),opening=payload?.opening&&typeof payload.opening==='object'?payload.opening:{},taste=opening.taste_bit||{},opening_problems=[];
  if(favoriteRefs.length===4){
    if(!(opening.greeting||[]).length)opening_problems.push('greeting');
    if(handle&&(opening.greeting||[]).some(line=>clean(line).toLowerCase().includes(handle.toLowerCase())))opening_problems.push('username_before_archetype');
    if(!clean(opening.archetype_lead))opening_problems.push('archetype_lead');
    if(handle&&clean(opening.archetype_lead).toLowerCase().includes(handle.toLowerCase()))opening_problems.push('username_before_archetype');
    if(!validArchetype(opening.archetype_phrase,{handle:info.Username,titles:favoriteTitles}))opening_problems.push('archetype_phrase');
    if(!(opening.archetype_after||[]).length)opening_problems.push('archetype_after');
    if(!clean(opening.username_line))opening_problems.push('username_line');
    for(const key of ['lead','strike','correction','tail'])if(!clean(taste[key]))opening_problems.push(`taste_${key}`);
    if(!clean(opening.judge_claim))opening_problems.push('judge_claim');
    if(!(opening.transition||[]).length)opening_problems.push('transition');
  }
  const opening_valid=opening_problems.length===0;
  if(!opening_valid)invalid.push({kind:'opening',problems:opening_problems});
  // "Usable" is the failure bar, never "perfectly valid": an opening with at least the arrival beat
  // still renders a real session, so a 95%-good answer is not discarded over one missing field.
  const opening_usable=Boolean((opening.greeting||[]).length||clean(opening.archetype_lead)||clean(opening.username_line));
  const prText=clean(payload?.profile_review?.text),prRich=rich(payload?.profile_review?.text),prRefs=registry.normalizeRefs(refsOf(payload?.profile_review?.evidence_refs)),profile_review_ai_like=/^(é incrível como|este perfil|esse perfil|este usuário|esse usuário|fica claro|uma mistura de)\b/i.test(prText),profile_review=prText?{text:prRich,evidence_refs:prRefs.refs}:null,profile_review_valid=Boolean(prText)&&prRefs.refs.length>0;
  if(payload?.profile_review&&!profile_review_valid)invalid.push({kind:'profile_review',reason:prText?'invalid_refs':'missing_text'});
  const games_missing=Math.max(0,required_games-games.length);if(games_missing)invalid.push({kind:'games',reason:`missing_games:${games_missing}`});
  const core_contract_complete=opening_valid&&moments.length>0&&profile_review_valid&&games_missing===0;
  const clean_run=core_contract_complete&&!profile_review_ai_like&&!moments_invalid.length&&!attachments_invalid.length&&!games_invalid.length&&!refs_dropped&&moments_received===moments.length;
  const generation_status=!core_contract_complete?'core_incomplete':(clean_run?'complete':'optional_partial'),partial_visible=core_contract_complete&&moments_invalid.length>0;
  const validation_summary={core_contract_complete,opening:opening_valid,opening_usable,username_before_archetype:opening_problems.includes('username_before_archetype'),opening_problems,required_games,games_received,games_valid:games.length,games_missing,profile_review:profile_review_valid,profile_review_ai_like,moments_received,moments_valid:moments.length,moments_invalid:moments_invalid.length,attachments_valid,attachments_invalid:attachments_invalid.length,refs_dropped,partial_visible};
  return {opening,opening_valid,opening_usable,opening_problems,moments,moments_received,moments_invalid,games,games_received,games_invalid,required_games,games_missing,profile_review,profile_review_valid,profile_review_ai_like,core_contract_complete,partial_visible,closer:linesOf(payload?.closer),ending:{title:clean(payload?.ending?.title).split(/\s+/).slice(0,6).join(' ')},attachments_valid,attachments_invalid,invalid,validation_summary,generation_status,valid:core_contract_complete};
}
