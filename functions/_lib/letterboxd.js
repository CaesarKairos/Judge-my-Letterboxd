import {csvObjects,parseCsv} from './csv.js';
import {reviewStyle} from './review-style.js';
import {buildRelationships} from './relationships.js';
import {temporalProfile} from './temporal.js';

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
  const likesFilms=read('likes/films.csv'),likesReviews=read('likes/reviews.csv'),likesLists=read('likes/lists.csv'),comments=read('comments.csv');
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
  // profile.csv may contain private columns. The normalized profile intentionally keeps
  // only the identity needed by the experience; raw_export is separately sanitized.
  const known=new Set(['profile.csv','watched.csv','ratings.csv','diary.csv','reviews.csv','watchlist.csv','comments.csv','likes/films.csv','likes/reviews.csv','likes/lists.csv']);
  const files_processed=[...entries.keys()].filter(path=>!/(^|\/)(deleted|orphaned)(\/|$)/i.test(path));
  return {
    handle:(profileRow.Username||'').trim(),name:(profileRow['Display Name']||profileRow.Username||profileRow['Given Name']||'').trim(),
    films:[...films.values()],sessions,reviews:reviewRows,lists,watchlist:watchlist.length,topFour,
    likes:{films:likesFilms.length,reviews:likesReviews.length,lists:likesLists.length},comments:comments.length,
    inventory:{files_processed:files_processed.length,files_in_zip:entries.size,known_files:files_processed.filter(path=>known.has(path)||/^lists\/[^/]+\.csv$/i.test(path)),unknown_files:files_processed.filter(path=>!known.has(path)&&!/^lists\/[^/]+\.csv$/i.test(path))}
  };
}

const stat=(key,value,label)=>({key,value,label});
const byCount=values=>[...values.entries()].sort((a,b)=>b[1]-a[1]);
export function analyzeExport(profile,locale='pt-BR') {
  const pt=locale==='pt-BR',labels=pt?{films:'filmes vistos',reviews:'reviews',sessions:'sessões',ratings:'ratings',rewatches:'rewatches'}:{films:'films watched',reviews:'reviews',sessions:'sessions',ratings:'ratings',rewatches:'rewatches'};
  const rated=profile.films.filter(f=>f.rating!=null),rewatches=profile.sessions.filter(s=>s.rewatch).length;
  const stats=[stat('watched_films',profile.films.length,labels.films),stat('reviews',profile.reviews.length,labels.reviews),stat('diary_entries',profile.sessions.length,labels.sessions),stat('rated_films',rated.length,labels.ratings),stat('explicit_rewatches',rewatches,labels.rewatches)].filter(s=>s.value>0);
  const moments=[];
  const style=reviewStyle(profile.reviews),relationships=buildRelationships(profile);
  if(rated.length>=2){const sorted=[...rated].sort((a,b)=>a.rating-b.rating);moments.push({id:'rating-contrast',type:'film_pair',films:[sorted[0],sorted.at(-1)],facts:`${sorted[0].title}: ${sorted[0].rating}/5; ${sorted.at(-1).title}: ${sorted.at(-1).rating}/5`});}
  const sessionsByFilm=new Map();for(const row of profile.sessions){const group=sessionsByFilm.get(row.film_key)||[];group.push(row);sessionsByFilm.set(row.film_key,group);}
  const repeated=[...sessionsByFilm.entries()].filter(([,rows])=>rows.length>1).sort((a,b)=>b[1].length-a[1].length)[0];
  if(repeated){const film=profile.films.find(f=>f.film_key===repeated[0])||repeated[1][0];moments.push({id:'rewatch',type:'rewatch',film,sessions:repeated[1],stats:[stat('sessions',repeated[1].length,pt?'sessões':'sessions')],facts:`${film.title}: ${repeated[1].length} sessions; ratings ${repeated[1].map(s=>s.rating??'?').join(' → ')}`});}
  const filmByKey=new Map(profile.films.map(film=>[film.film_key,film]));
  const tagCounts=new Map();for(const row of profile.sessions)for(const tag of row.tags)tagCounts.set(tag,(tagCounts.get(tag)||0)+1);
  for(const [index,[tag,count]] of byCount(tagCounts).entries()){
    moments.push({id:index?'tag-'+tag:'tag',type:'tag',tag,stats:[stat('sessions',count,pt?'sessões':'sessions')],films:profile.sessions.filter(s=>s.tags.includes(tag)).slice(0,3).map(row=>ratedRow(filmByKey,row)),facts:`tag ${tag} used ${count} times`});
  }
  for(const [index,list] of (profile.lists||[]).entries())moments.push({id:index?'list-'+list.name:'list',type:'list',...list,stats:[stat('films',list.count,pt?'filmes':'films')],facts:`list ${list.name}, ${list.count} films`});
  // A pair is only offered when the two films share something real (a tag or a list), so the
  // Analyst never has to defend a comparison that exists only because two scores are far apart.
  const extremes=keys=>{const rows=[...new Set(keys)].map(key=>filmByKey.get(key)).filter(film=>Number.isFinite(film?.rating));if(rows.length<3)return null;const sorted=rows.sort((a,b)=>a.rating-b.rating);return sorted.at(-1).rating-sorted[0].rating>=2?{low:sorted[0],high:sorted.at(-1)}:null;};
  for(const group of relationships.tag_films){const pair=extremes(group.films);if(pair)moments.push({id:`contrast-tag-${group.tag}`,type:'film_pair',films:[pair.low,pair.high],stats:[stat('tagged',group.count,pt?'filmes com a tag':'tagged films')],facts:`same tag ${group.tag}: ${pair.low.title} ${pair.low.rating}/5 vs ${pair.high.title} ${pair.high.rating}/5 across ${group.count} tagged films`});}
  for(const list of profile.lists||[]){const pair=extremes(list.films.map(film=>film.film_key));if(pair)moments.push({id:`contrast-list-${list.name}`,type:'film_pair',films:[pair.low,pair.high],stats:[stat('members',list.count,pt?'filmes na lista':'list members')],facts:`same list ${list.name}: ${pair.low.title} ${pair.low.rating}/5 vs ${pair.high.title} ${pair.high.rating}/5 among ${list.count} members`});}
  const phraseCandidates=[...style.recurring.trigrams,...style.recurring.bigrams,...style.recurring.starts].map(row=>row.text);let phraseMoment=null;
  for(const phrase of phraseCandidates){const matching=profile.reviews.filter(r=>r.text.toLocaleLowerCase().includes(phrase));if(matching.length>=2&&(!phraseMoment||matching.length>phraseMoment.count))phraseMoment={phrase,count:matching.length,reviews:matching};}
  if(phraseMoment)moments.unshift({id:'phrase',type:'phrase',phrase:phraseMoment.phrase,stats:[stat('reviews',phraseMoment.count,'reviews'),stat('share',phraseMoment.count/profile.reviews.length,pt?'proporção':'share')],examples:phraseMoment.reviews.slice(0,2),facts:`phrase "${phraseMoment.phrase}" appears in ${phraseMoment.count}/${profile.reviews.length} reviews`});
  // Review spotlights are a spread, not a rule. The two shortest reviews stay because the
  // contract always showed them, and length/rating extremes are offered beside them so the
  // Analyst can choose the review that actually says something about the account.
  const spotlight=[],taken=new Set();
  const offer=(id,review,reason)=>{if(review&&!taken.has(review.review_id)){taken.add(review.review_id);spotlight.push({id,review,reason});}};
  for(const [index,review] of [...profile.reviews].sort((a,b)=>a.text.length-b.text.length).slice(0,2).entries())offer(`quote-review-${index+1}`,review,pt?'review curta':'short review');
  offer('quote-longest',[...profile.reviews].sort((a,b)=>b.text.length-a.text.length)[0],pt?'review mais longa':'longest review');
  const ratedReviews=profile.reviews.filter(review=>Number.isFinite(review.rating));
  offer('quote-lowest',[...ratedReviews].sort((a,b)=>a.rating-b.rating)[0],pt?'menor nota da review':'lowest review score');
  offer('quote-highest',[...ratedReviews].sort((a,b)=>b.rating-a.rating)[0],pt?'maior nota da review':'highest review score');
  offer('quote-tagged',profile.reviews.find(review=>review.tags?.length),pt?'review com tag':'tagged review');
  for(const row of spotlight)moments.push({id:row.id,type:'review_quote',review:row.review,facts:`${row.reason} ${row.review.review_id} on ${row.review.title} (${row.review.year}), review rating ${row.review.rating??'unrated'}, ${row.review.text.length} chars, tags ${(row.review.tags||[]).join('|')||'none'}, rewatch ${row.review.rewatch?'yes':'no'}: ${row.review.text.slice(0,500)}`});
  for(const relation of relationships.relations.filter(row=>row.type==='tag_list'&&row.intersection>=2).slice(0,8)){
    const list=profile.lists.find(item=>item.name===relation.list),tagFilms=relation.films.map(key=>filmByKey.get(key)).filter(Boolean);
    moments.push({id:`tag-list-${relation.tag}-${relation.list}`,type:'tag',tag:relation.tag,related_tag:relation.list,films:tagFilms,stats:[stat('coverage',relation.coverage,pt?'da lista':'of list'),stat('films',relation.intersection,pt?'filmes em comum':'shared films')],facts:`tag ${relation.tag} intersects list ${relation.list} in ${relation.intersection} films`,relationship:relation,list});
  }
  const temporal=temporalProfile(profile);
  if(temporal.busiest_period)moments.push({id:'temporal-peak',type:'stat',stats:[stat('sessions',temporal.busiest_period.sessions,pt?'sessões':'sessions'),stat('months',temporal.months_tracked,pt?'meses registrados':'logged months')],facts:`busiest logged period ${temporal.busiest_period.month}: ${temporal.busiest_period.sessions} sessions over ${temporal.months_tracked} months and ${temporal.span_days} days`});
  if(temporal.rating_drift)moments.push({id:'temporal-rating-drift',type:'stat',stats:[stat('early_mean',temporal.rating_drift.early,pt?'média no início':'early mean'),stat('late_mean',temporal.rating_drift.late,pt?'média depois':'late mean')],facts:`session ratings around the diary: early mean ${temporal.rating_drift.early} over ${temporal.rating_drift.early_count} sessions, late mean ${temporal.rating_drift.late} over ${temporal.rating_drift.late_count} sessions, observed difference ${temporal.rating_drift.delta}`});
  if(temporal.verbosity_drift)moments.push({id:'temporal-verbosity',type:'stat',stats:[stat('early_length',temporal.verbosity_drift.early,pt?'caracteres no início':'early chars'),stat('late_length',temporal.verbosity_drift.late,pt?'caracteres depois':'late chars')],facts:`review length around the diary: early ${temporal.verbosity_drift.early} chars, late ${temporal.verbosity_drift.late} chars, observed difference ${temporal.verbosity_drift.delta}`});
  if(temporal.rewatch_moves.length)moments.push({id:'temporal-rewatch-moves',type:'stat',stats:[stat('films',temporal.rewatch_moves.length,pt?'filmes reassistidos':'films revisited')],facts:`ratings across repeat sessions: ${temporal.rewatch_moves.map(row=>`${filmByKey.get(row.film_key)?.title||row.film_key} ${row.ratings.join(' → ')} (${row.delta>=0?'+':''}${row.delta})`).join('; ')}`});
  // The deterministic pass is a candidate pool, not the final script: the Analyst selects and
  // the Script Engine decides the 10-16 beats. This cap only bounds the AI payload.
  return {stats,moments:moments.slice(0,48),temporal,overview:{watched:profile.films.length,reviews:profile.reviews.length,sessions:profile.sessions.length,ratings:rated.length,rewatches,watchlist:profile.watchlist,likes:profile.likes?.films||0,lists:profile.lists.length,tags:tagCounts.size},review_style:style,relationships,review_coverage:{sessions_with_review:new Set(profile.reviews.map(review=>review.film_key)).size,sessions_without_review:Math.max(0,profile.sessions.length-new Set(profile.reviews.map(review=>review.film_key)).size),reviews_without_diary:profile.reviews.filter(review=>!profile.sessions.some(session=>session.film_key===review.film_key)).length}};
}
