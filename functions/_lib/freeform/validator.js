import {archiveRefs} from './archive-json.js';

const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
const refsOf=value=>(Array.isArray(value)?value:[]).map(clean).filter(Boolean);
const linesOf=value=>(Array.isArray(value)?value:[]).map(clean).filter(Boolean).slice(0,5);

export function validateFreeformResponse(payload,archive){
  const registry=archiveRefs(archive),invalid=[];
  const validRefs=refs=>refs.length>0&&refs.every(ref=>registry.has(ref));
  const moments=[];
  for(const [index,row] of (Array.isArray(payload?.moments)?payload.moments:[]).slice(0,20).entries()){
    const evidence_refs=refsOf(row?.evidence_refs);
    if(!row||!validRefs(evidence_refs)){invalid.push({kind:'moment',index,id:row?.id||null,invalid_refs:evidence_refs.filter(ref=>!registry.has(ref))});continue;}
    moments.push({id:clean(row.id)||`moment_${String(index+1).padStart(2,'0')}`,type:clean(row.type)||'custom',title:clean(row.title),display:row.display&&typeof row.display==='object'?row.display:{kind:'custom'},display_text:clean(row.display_text),lines:linesOf(row.lines),evidence_refs});
  }
  const games=[];
  for(const [index,row] of (Array.isArray(payload?.games)?payload.games:[]).slice(0,2).entries()){
    const evidence_refs=refsOf(row?.evidence_refs),films=(Array.isArray(row?.films)?row.films:[]).filter(f=>f&&clean(f.title)).slice(0,3);
    if(!validRefs(evidence_refs)||films.length!==3||new Set(films.map(f=>`${clean(f.title)}|${f.year||''}`)).size!==3){invalid.push({kind:'game',index,id:row?.id||null,invalid_refs:evidence_refs.filter(ref=>!registry.has(ref))});continue;}
    games.push({...row,id:clean(row.id)||`game_${index+1}`,type:['forced_triage','blind_rank','defend_your_take'].includes(row.type)?row.type:'forced_triage',films,evidence_refs});
  }
  const profileRefs=refsOf(payload?.profile_review?.evidence_refs),profile_review=clean(payload?.profile_review?.text)&&validRefs(profileRefs)?{text:clean(payload.profile_review.text),evidence_refs:profileRefs}:null;
  if(payload?.profile_review&&!profile_review)invalid.push({kind:'profile_review',invalid_refs:profileRefs.filter(ref=>!registry.has(ref))});
  return {opening:payload?.opening&&typeof payload.opening==='object'?payload.opening:{},moments,games,closer:linesOf(payload?.closer),profile_review,invalid,valid:moments.length>0&&Boolean(profile_review)};
}
