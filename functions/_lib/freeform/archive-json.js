import {parseCsv} from '../csv.js';

const decoder=new TextDecoder('utf-8',{fatal:false});
const textExtensions=/\.(csv|txt|json|md|html?|xml|yaml|yml|log)$/i;
const mimeFor=path=>path.toLowerCase().endsWith('.csv')?'text/csv':path.toLowerCase().endsWith('.json')?'application/json':textExtensions.test(path)?'text/plain':'application/octet-stream';
const base64=bytes=>{let out='';for(let at=0;at<bytes.length;at+=0x8000)out+=String.fromCharCode(...bytes.subarray(at,at+0x8000));return btoa(out);};
const hex=bytes=>[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
const safePath=value=>String(value||'').replace(/\\/g,'/');
const isProbablyText=bytes=>{
  if(!bytes.length)return true;
  const sample=bytes.subarray(0,Math.min(bytes.length,8192));let controls=0;
  for(const value of sample){if(value===0)return false;if(value<9||(value>13&&value<32))controls++;}
  return controls/sample.length<.02;
};

export async function buildFreeformArchive(entries,{filename='letterboxd.zip',binaryInlineLimit=256*1024}={}){
  const files=[];let rowCount=0,textChars=0,reviews=0,lists=0,unknown=0;
  for(const [rawPath,value] of entries){
    const path=safePath(rawPath),bytes=value instanceof Uint8Array?value:new Uint8Array(value),mime_type=mimeFor(path);
    const digest=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
    const textual=textExtensions.test(path)||isProbablyText(bytes);
    if(textual){
      const raw_text=decoder.decode(bytes),format=path.toLowerCase().endsWith('.csv')?'csv':'text';textChars+=raw_text.length;
      if(format==='csv'){
        const parsed=parseCsv(raw_text),rows=parsed.map((cells,index)=>({ref:`${path}#row:${index+1}`,index:index+1,cells}));
        rowCount+=rows.length;
        if(path.toLowerCase()==='reviews.csv')reviews=Math.max(0,rows.length-1);
        if(/^lists\/.*\.csv$/i.test(path))lists++;
        if(!/^(profile|watched|ratings|diary|reviews|watchlist|comments)\.csv$/i.test(path)&&!/^likes\/.*\.csv$/i.test(path)&&!/^lists\/.*\.csv$/i.test(path))unknown++;
        files.push({path,format,mime_type,size:bytes.length,sha256:digest,raw_text,headers:parsed[0]||[],rows});
      }else{unknown++;files.push({path,format,mime_type,size:bytes.length,sha256:digest,raw_text,ref:`${path}#text`});}
    }else{
      unknown++;files.push({path,format:'binary',mime_type,size:bytes.length,sha256:digest,ref:`${path}#binary`,...(bytes.length<=binaryInlineLimit?{base64:base64(bytes)}:{base64_omitted:true})});
    }
  }
  const archive={filename,file_count:files.length,row_count:rowCount,text_chars:textChars,reviews,lists,unknown_files:unknown};
  const lossless={version:1,archive,files};
  // CSV cells are the same information as raw_text, so the AI form keeps all cells once instead
  // of paying twice for identical text. Non-CSV text remains byte-for-byte decoded as raw_text.
  const ai={version:1,archive,files:files.map(file=>file.format==='csv'?{path:file.path,format:file.format,mime_type:file.mime_type,size:file.size,sha256:file.sha256,headers:file.headers,rows:file.rows}:file.format==='binary'?{path:file.path,format:'binary',mime_type:file.mime_type,size:file.size,sha256:file.sha256,ref:file.ref,base64_in_lossless:Boolean(file.base64)}:file)};
  return {lossless,ai,diagnostics:{files:files.length,rows:rowCount,text_chars:textChars,reviews,lists,unknown_files:unknown,archive_lossless_chars:JSON.stringify(lossless).length,archive_ai_chars:JSON.stringify(ai).length}};
}

export function archiveRefs(archive){
  const refs=new Map();
  for(const file of archive.files||[]){
    if(file.ref)refs.set(file.ref,{file});
    for(const row of file.rows||[])refs.set(row.ref,{file,row});
  }
  return refs;
}
