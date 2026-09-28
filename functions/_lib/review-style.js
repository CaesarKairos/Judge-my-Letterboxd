const words=text=>String(text||'').toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)||[];
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);return sorted.length?sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2:0;};
const frequent=(items,min=2,limit=12)=>[...items.entries()].filter(([,count])=>count>=min).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,limit).map(([text,count])=>({text,count}));

// This deliberately measures patterns rather than looking for a favorite phrase.
// A phrase such as "dito isso" appears only if the account actually makes it recur.
export function reviewStyle(reviews=[]){
  const texts=reviews.map(review=>String(review.text||'').trim()).filter(Boolean);
  const unigram=new Map(),bigram=new Map(),trigram=new Map(),starts=new Map(),ends=new Map();
  let blockquotes=0,strong=0,em=0,exclamations=0,questions=0;
  const lengths=[],sentences=[];
  for(const review of reviews){
    const text=String(review.text||'').trim(),tokens=words(text);if(!text)continue;
    lengths.push(text.length);sentences.push(...text.split(/[.!?]+/).map(part=>words(part).length).filter(Boolean));
    for(const segment of review.segments||[]){if(segment.type==='blockquote')blockquotes++;if(segment.type==='strong')strong++;if(segment.type==='em')em++;}
    exclamations+=(text.match(/!/g)||[]).length;questions+=(text.match(/\?/g)||[]).length;
    for(let index=0;index<tokens.length;index++){
      if(tokens[index].length>=4)unigram.set(tokens[index],(unigram.get(tokens[index])||0)+1);
      if(index+1<tokens.length){const phrase=tokens.slice(index,index+2).join(' ');bigram.set(phrase,(bigram.get(phrase)||0)+1);}
      if(index+2<tokens.length){const phrase=tokens.slice(index,index+3).join(' ');trigram.set(phrase,(trigram.get(phrase)||0)+1);}
    }
    if(tokens.length>=2)starts.set(tokens.slice(0,Math.min(4,tokens.length)).join(' '),(starts.get(tokens.slice(0,Math.min(4,tokens.length)).join(' '))||0)+1);
    if(tokens.length>=2)ends.set(tokens.slice(-Math.min(4,tokens.length)).join(' '),(ends.get(tokens.slice(-Math.min(4,tokens.length)).join(' '))||0)+1);
  }
  const count=texts.length,short_reviews=lengths.filter(value=>value<=60).length,long_reviews=lengths.filter(value=>value>=500).length;
  return {
    review_count:count,average_length:count?Math.round(lengths.reduce((sum,value)=>sum+value,0)/count):0,median_length:Math.round(median(lengths)),
    average_sentence_length:sentences.length?Math.round(sentences.reduce((sum,value)=>sum+value,0)/sentences.length):0,
    short_reviews,long_reviews,markup:{blockquotes,strong,em},punctuation:{exclamations,questions},
    recurring:{unigrams:frequent(unigram,Math.max(2,Math.ceil(count*.12))),bigrams:frequent(bigram,2),trigrams:frequent(trigram,2),starts:frequent(starts,2),ends:frequent(ends,2)}
  };
}
