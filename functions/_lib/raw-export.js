import {csvObjects} from './csv.js';

const PRIVATE_PROFILE=/email|address|street|city|country|postal|zip|phone|birth/i;
const inactive=path=>/(^|\/)(deleted|orphaned)(\/|$)/i.test(path);
const sanitizeProfile=rows=>rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!PRIVATE_PROFILE.test(key)&&['Username','Display Name','Given Name','Favorite Films'].includes(key))));

export function buildRawExport(entries){
  const files={},unknown=[];
  for(const [path,text] of entries){
    if(inactive(path)||!/\.csv$/i.test(path))continue;
    let rows=[];try{rows=csvObjects(text);}catch{}
    files[path.toLowerCase()==='profile.csv'?path:path]=path.toLowerCase()==='profile.csv'?sanitizeProfile(rows):rows;
    if(!/^(profile|watched|ratings|diary|reviews|watchlist|comments)\.csv$/i.test(path)&&!/^likes\/(films|reviews|lists)\.csv$/i.test(path)&&!/^lists\/[^/]+\.csv$/i.test(path))unknown.push(path);
  }
  return {file_count:Object.keys(files).length,files,unknown_files:unknown};
}
