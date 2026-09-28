const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const round=value=>value==null?null:Math.round(value*100)/100;
const monthOf=value=>String(value||'').slice(0,7);

// Time is a measurement, never a cause. Every number here only exists when the export
// really carries dated rows, and an early/late split is reported as an observed
// difference between two halves of the diary, not as a change in taste.
export function temporalProfile(profile){
  const sorted=(rows,key)=>[...(rows||[])].filter(row=>row[key]).sort((a,b)=>String(a[key]).localeCompare(String(b[key])));
  const sessions=sorted(profile.sessions,'date'),reviews=sorted(profile.reviews,'date');
  const periods=new Map();
  for(const session of sessions){const month=monthOf(session.date);periods.set(month,(periods.get(month)||0)+1);}
  const ranked=[...periods.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  // Eight rows is the floor: below that a half is noise, so no drift is offered at all.
  const split=(rows,pick)=>{
    if(rows.length<8)return null;
    const half=Math.floor(rows.length/2),early=rows.slice(0,half),late=rows.slice(half);
    const left=mean(early.map(pick).filter(Number.isFinite)),right=mean(late.map(pick).filter(Number.isFinite));
    if(left==null||right==null)return null;
    return {early:round(left),late:round(right),delta:round(right-left),early_count:early.length,late_count:late.length,early_from:String(early[0]?.date||''),late_to:String(late.at(-1)?.date||'')};
  };
  const sessionsByFilm=new Map();
  for(const session of sessions){const group=sessionsByFilm.get(session.film_key)||[];group.push(session);sessionsByFilm.set(session.film_key,group);}
  const rewatch_moves=[...sessionsByFilm.entries()].map(([film_key,rows])=>{
    const known=rows.map(row=>row.rating).filter(Number.isFinite);
    const delta=known.length>=2?round(known.at(-1)-known[0]):null;
    // A repeat that kept the exact same score is already the rewatch measurement; only a real
    // move between sessions becomes its own candidate here.
    return delta?{film_key,sessions:rows.length,ratings:known,delta,first_date:String(rows[0].date||''),last_date:String(rows.at(-1).date||'')}:null;
  }).filter(Boolean).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)||b.sessions-a.sessions).slice(0,4);
  return {
    months_tracked:periods.size,
    span_days:sessions.length>=2?Math.round((Date.parse(sessions.at(-1).date)-Date.parse(sessions[0].date))/86400000):null,
    // A busy month only means something once the diary is long enough to have a quieter one.
    busiest_period:sessions.length>=8&&periods.size>=3&&ranked.length?{month:ranked[0][0],sessions:ranked[0][1]}:null,
    periods:[...periods.entries()].sort((a,b)=>a[0].localeCompare(b[0])),
    rating_drift:split(sessions.filter(row=>Number.isFinite(row.rating)),row=>row.rating),
    verbosity_drift:split(reviews,row=>String(row.text||'').length),
    rewatch_moves
  };
}
