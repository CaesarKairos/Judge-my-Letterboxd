import {el,parseMarkup} from './utils.js';
import {t} from './i18n.js';
import {filmCard,rating} from './poster-service.js';
const percentages=new Set(['share','jaccard','percent_a_in_b','percent_b_in_a']);
export function stats(rows=[]) {
  const list=el('dl','stats');
  for(const row of rows.filter(s=>s&&s.value!=null)) {
    const item=el('div');item.append(el('dt','',row.label||row.key),el('dd','',percentages.has(row.key)&&typeof row.value==='number'?`${(row.value*100).toFixed(1)}%`:row.value));list.append(item);
  }return list;
}
export function filmStrip(films=[],top=false) {
  const strip=el('div',`film-strip ${top?'top-four':''} count-${Math.min(films.length,4)}`);
  films.slice(0,4).forEach(f=>strip.append(filmCard(f,{eager:top})));return strip;
}
export function quoteRows(event) {
  // A review may arrive already segmented (Letterboxd markup) or as one plain string.
  // Both paths end in real elements, so `<blockquote>` can never be printed as text.
  const rows = [];
  const segments = Array.isArray(event.segments) && event.segments.length ? event.segments : [{type:'text', text:event.text}];
  for (const segment of segments) {
    const type = segment?.type || 'text';
    for (const part of parseMarkup(segment?.text ?? '')) rows.push({type:part.type === 'text' ? type : part.type, text:part.text});
  }
  if (!rows.length) for (const part of parseMarkup(event.text ?? '')) rows.push(part);
  return rows;
}
export function renderAttachment(event) {
  const box=el('section',`attachment attachment-${event.type}`);box.dataset.event=event.type;
  switch(event.type) {
    case 'film': box.append(filmCard(event.film||{}));break;
    case 'film_pair': case 'film_group':box.append(filmStrip(event.films));break;
    case 'rating':box.append(el('strong','',event.title),el('span','film-year',event.year),rating(event.rating));break;
    case 'profile_stats':case 'stat':
      if(event.caption)box.append(el('p','caption',event.caption));box.append(stats(event.stats));break;
    case 'review_quote': {
      if(event.title){const header=el('header','review-header');header.append(el('strong','',event.title),el('span','film-year',event.year),rating(event.rating));box.append(header);}
      const quote=el('blockquote','review');
      for(const row of quoteRows(event)) {
        const tag=({strong:'strong',em:'em',blockquote:'blockquote',paragraph:'p'})[row.type]||'p';
        quote.append(el(tag,'',row.text));
      }box.append(quote);break;
    }
    case 'phrase':{
      box.append(el('div','eyebrow',t('evidence')),el('p','phrase',`“${event.phrase}”`),stats(event.stats));
      const share=event.stats?.find(s=>s.key==='share');if(share){const meter=el('meter');meter.min=0;meter.max=1;meter.value=share.value;meter.setAttribute('aria-label',event.phrase);box.append(meter);}break;
    }
    case 'rewatch':{
      if(event.film)box.append(filmCard(event.film));
      const timeline=el('ol','rewatch-timeline');for(const session of event.sessions||[]){const step=el('li');step.append(rating(session.rating),el('time','',session.date||session.logged_date||''));timeline.append(step);}box.append(timeline,stats(event.stats));break;
    }
    case 'tag':box.append(el('span','tag-pill',event.tag));if(event.related_tag)box.append(el('span','tag-cross',' × '),el('span','tag-pill',event.related_tag));box.append(stats(event.stats));if(event.films?.length)box.append(filmStrip(event.films));break;
    case 'list':{
      box.append(el('h3','',event.name));if(event.description){const detail=el('details');detail.append(el('summary','',t('more')),el('p','description',event.description));box.append(detail);}box.append(filmStrip(event.films),stats(event.stats));if(event.count!=null)box.append(el('span','',event.count));break;
    }
    default:return null;
  }
  if(!box.textContent.trim()&&!box.querySelector('img'))return null;
  return box;
}
