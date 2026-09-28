import {csvObjects,parseCsv} from './csv.js';

const keyOf=(name,year)=>`${String(name||'').normalize('NFC').trim().toLocaleLowerCase()}|${String(year||'').trim()}`;
const number=value=>value===''||value==null?null:Number.isFinite(Number(value))?Number(value):null;
const boxdId=value=>{try{return new URL(value).pathname.split('/').filter(Boolean).at(-1)||'';}catch{return '';}};
const filmFrom=row=>({film_key:keyOf(row.Name,row.Year),title:(row.Name||'').trim(),year:(row.Year||'').trim(),rating:number(row.Rating)});
const tags=value=>String(value||'').split(',').map(item=>item.trim()).filter(Boolean);
// Lists and tags render film cards, and a card shows the film's current rating: a list row has no
// rating column at all, and a diary line carries the rating of that one session. Both are resolved
// through the film registry, so a rated film is never printed as "not rated" there; a film that is
// not in the registry keeps what the row itself said (usually null, never an invented score).
const ratedRow=(filmByKey,row)=>({...row,rating:filmByKey.get(row.film_key)?.rating??row.rating??null});
const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
const decodeEntities=value=>value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,entity)=>{
  if(entity[0]==='#'){const radix=entity[1].toLowerCase()==='x'?16:10,raw=entity.slice(radix===16?2:1),code=Number.parseInt(raw,radix);return Number.isFinite(code)?String.fromCodePoint(code):'';}
  return entities[entity.toLowerCase()]||'';
});

const markupTypes={blockquote:'blockquote',strong:'strong',b:'strong',em:'em',i:'em',p:'paragraph'};

export function structuredReview(value) {
  const input=String(value||'').replace(/[\u200B-\u200D\uFEFF]/g,''),segments=[];let cursor=0,stack=[];
  const push=(type,text)=>{const clean=decodeEntities(text).replace(/\r\n?/g,'\n');if(!clean)return;const previous=segments.at(-1);if(previous?.type===type)previous.text+=clean;else segments.push({type,text:clean});};
  for(const match of input.matchAll(/<[^>]*>/g)){
    push(stack.at(-1)||'text',input.slice(cursor,match.index));cursor=match.index+match[0].length;
    const tag=match[0].match(/^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/);if(!tag)continue;
    const closing=Boolean(tag[1]),name=tag[2].toLowerCase();
    if(name==='br'){push(stack.at(-1)||'text','\n');continue;}
    const type=markupTypes[name];if(!type)continue;
    if(type==='paragraph'&&!closing&&segments.length)push(stack.at(-1)||'text','\n');
    if(closing){const found=stack.lastIndexOf(type);if(found>=0)stack=stack.slice(0,found);}else stack.push(type);
  }
  push(stack.at(-1)||'text',input.slice(cursor));
  const cleaned=segments.map(segment=>({...segment,text:segment.text.trim()})).filter(segment=>segment.text);
  return {text:cleaned.map(segment=>segment.text).join('\n'),segments:cleaned};
}

function parseList(text,path) {
  const rows=parseCsv(text),header=rows.findIndex(row=>row[0]==='Date'&&row[1]==='Name');
  const members=rows.findIndex(row=>row[0]==='Position'&&row[1]==='Name');
  const meta=header>=0&&rows[header+1]?Object.fromEntries(rows[header].map((key,i)=>[key,rows[header+1][i]||''])):{};
  const films=members>=0?rows.slice(members+1).filter(row=>row[0]).map(row=>({film_key:keyOf(row[1],row[2]),title:row[1],year:row[2]})):[];
  return {name:meta.Name||path.split('/').at(-1).replace(/\.csv$/i,''),description:meta.Description||'',films,count:films.length};
}

export function parseExport(entries) {
  const required=['profile.csv','watched.csv'];
  if(required.some(name=>!entries.has(name)))throw new Error('not_letterboxd_export');
  const read=name=>entries.has(name)?csvObjects(entries.get(name)):[];
  const profileRow=read('profile.csv')[0]||{},watched=read('watched.csv'),ratings=read('ratings.csv'),diary=read('diary.csv'),reviews=read('reviews.csv'),watchlist=read('watchlist.csv');
  const films=new Map();
  // ratings.csv carries the current rating, so it is merged last: a diary line or a review keeps
  // the rating of that session or of that text, and a film rated 5 today can still hold an older
  // 4.5. Those rows only fill a film without a ratings.csv row, so an export missing the file or
  // a rating does not lose every score.
  for(const row of [...watched,...diary,...reviews,...ratings]){
    const film=filmFrom(row);if(!film.title)continue;
    const current=films.get(film.film_key)||film;
    if(film.rating!=null)current.rating=film.rating;
    current.uri=current.uri||row['Letterboxd URI']||'';films.set(film.film_key,current);
  }
  const favoriteIds=String(profileRow['Favorite Films']||'').split(',').map(boxdId).filter(Boolean);
  const topFour=favoriteIds.map(id=>[...films.values()].find(f=>boxdId(f.uri)===id)).filter(Boolean).slice(0,4);
  const sessions=diary.map((row,index)=>({...filmFrom(row),date:row['Watched Date']||row.Date,rewatch:/^(yes|true|1)$/i.test(row.Rewatch),tags:tags(row.Tags),index:index+1}));
  const reviewRows=reviews.map((row,index)=>({...filmFrom(row),...structuredReview(row.Review),date:row['Watched Date']||row.Date,tags:tags(row.Tags),review_id:`review-${index+1}`})).filter(r=>r.text);
  const filmByKey=new Map([...films.values()].map(film=>[film.film_key,film]));
  const lists=[...entries].filter(([path])=>/^lists\/[^/]+\.csv$/i.test(path)).map(([path,text])=>parseList(text,path)).map(list=>({...list,films:list.films.map(row=>ratedRow(filmByKey,row))}));
  return {handle:(profileRow.Username||'').trim(),name:(profileRow.Username||profileRow['Given Name']||'').trim(),films:[...films.values()],sessions,reviews:reviewRows,lists,watchlist:watchlist.length,topFour};
}

const stat=(key,value,label)=>({key,value,label});
const byCount=values=>[...values.entries()].sort((a,b)=>b[1]-a[1]);
export function analyzeExport(profile,locale='pt-BR') {
  const pt=locale==='pt-BR',labels=pt?{films:'filmes vistos',reviews:'reviews',sessions:'sessões',ratings:'ratings',rewatches:'rewatches'}:{films:'films watched',reviews:'reviews',sessions:'sessions',ratings:'ratings',rewatches:'rewatches'};
  const rated=profile.films.filter(f=>f.rating!=null),rewatches=profile.sessions.filter(s=>s.rewatch).length;
  const stats=[stat('watched_films',profile.films.length,labels.films),stat('reviews',profile.reviews.length,labels.reviews),stat('diary_entries',profile.sessions.length,labels.sessions),stat('rated_films',rated.length,labels.ratings),stat('explicit_rewatches',rewatches,labels.rewatches)].filter(s=>s.value>0);
  const moments=[];
  if(rated.length>=2){const sorted=[...rated].sort((a,b)=>a.rating-b.rating);moments.push({id:'rating-contrast',type:'film_pair',films:[sorted[0],sorted.at(-1)],facts:`${sorted[0].title}: ${sorted[0].rating}/5; ${sorted.at(-1).title}: ${sorted.at(-1).rating}/5`});}
  const sessionsByFilm=new Map();for(const row of profile.sessions){const group=sessionsByFilm.get(row.film_key)||[];group.push(row);sessionsByFilm.set(row.film_key,group);}
  const repeated=[...sessionsByFilm.entries()].filter(([,rows])=>rows.length>1).sort((a,b)=>b[1].length-a[1].length)[0];
  if(repeated){const film=profile.films.find(f=>f.film_key===repeated[0])||repeated[1][0];moments.push({id:'rewatch',type:'rewatch',film,sessions:repeated[1],stats:[stat('sessions',repeated[1].length,pt?'sessões':'sessions')],facts:`${film.title}: ${repeated[1].length} sessions; ratings ${repeated[1].map(s=>s.rating??'?').join(' → ')}`});}
  const filmByKey=new Map(profile.films.map(film=>[film.film_key,film]));
  const tagCounts=new Map();for(const row of profile.sessions)for(const tag of row.tags)tagCounts.set(tag,(tagCounts.get(tag)||0)+1);
  const commonTag=byCount(tagCounts)[0];if(commonTag)moments.push({id:'tag',type:'tag',tag:commonTag[0],stats:[stat('sessions',commonTag[1],pt?'sessões':'sessions')],films:profile.sessions.filter(s=>s.tags.includes(commonTag[0])).slice(0,3).map(row=>ratedRow(filmByKey,row)),facts:`tag ${commonTag[0]} used ${commonTag[1]} times`});
  if(profile.lists[0])moments.push({id:'list',type:'list',...profile.lists[0],stats:[stat('films',profile.lists[0].count,pt?'filmes':'films')],facts:`list ${profile.lists[0].name}, ${profile.lists[0].count} films`});
  const phraseCandidates=['dito isso','honestly','but still','overall'];let phraseMoment=null;
  for(const phrase of phraseCandidates){const matching=profile.reviews.filter(r=>r.text.toLocaleLowerCase().includes(phrase));if(matching.length>=2&&(!phraseMoment||matching.length>phraseMoment.count))phraseMoment={phrase,count:matching.length,reviews:matching};}
  if(phraseMoment)moments.unshift({id:'phrase',type:'phrase',phrase:phraseMoment.phrase,stats:[stat('reviews',phraseMoment.count,'reviews'),stat('share',phraseMoment.count/profile.reviews.length,pt?'proporção':'share')],examples:phraseMoment.reviews.slice(0,2),facts:`phrase "${phraseMoment.phrase}" appears in ${phraseMoment.count}/${profile.reviews.length} reviews`});
  for(const review of [...profile.reviews].sort((a,b)=>a.text.length-b.text.length).slice(0,2))moments.push({id:`quote-${review.review_id}`,type:'review_quote',review,facts:`${review.title} (${review.year}), ${review.rating??'unrated'}: ${review.text.slice(0,500)}`});
  return {stats,moments:moments.slice(0,8),overview:{watched:profile.films.length,reviews:profile.reviews.length,sessions:profile.sessions.length,ratings:rated.length,rewatches,watchlist:profile.watchlist}};
}
