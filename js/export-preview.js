import {unzipText} from './zip.js';
import {csvObjects} from './csv.js';

const shuffle=list=>{const copy=[...list];for(let i=copy.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[copy[i],copy[j]]=[copy[j],copy[i]];}return copy;};
export async function filmsFromExport(file){
  const entries=await unzipText(await file.arrayBuffer(),{maxEntries:80,maxExpanded:24*1024*1024}),seen=new Set(),films=[];
  for(const name of ['watched.csv','ratings.csv','diary.csv'])for(const row of csvObjects(entries.get(name)||'')){const title=(row.Name||row.Title||'').trim(),year=(row.Year||'').trim(),key=`${title.toLowerCase()}|${year}`;if(title&&!seen.has(key)){seen.add(key);films.push({title,year});}}
  return shuffle(films).slice(0,30);
}
