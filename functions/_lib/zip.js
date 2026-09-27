const decoder=new TextDecoder('utf-8',{fatal:false});
const u16=(view,at)=>view.getUint16(at,true),u32=(view,at)=>view.getUint32(at,true);

async function inflate(bytes,maxOutput) {
  const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks=[];let size=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxOutput){await reader.cancel();throw new Error('zip_too_large');}chunks.push(value);}
  }finally{reader.releaseLock();}
  const output=new Uint8Array(size);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}return output;
}

export async function unzip(buffer,{maxEntries=80,maxExpanded=24*1024*1024}={}) {
  const bytes=new Uint8Array(buffer),view=new DataView(buffer);
  let eocd=-1;
  for(let i=Math.max(0,bytes.length-65557);i<=bytes.length-22;i++)if(u32(view,i)===0x06054b50)eocd=i;
  if(eocd<0)throw new Error('invalid_zip');
  const count=u16(view,eocd+10),centralOffset=u32(view,eocd+16);
  if(count>maxEntries)throw new Error('zip_too_many_files');
  const files=new Map();let cursor=centralOffset,total=0;
  for(let index=0;index<count;index++){
    if(cursor+46>bytes.length||u32(view,cursor)!==0x02014b50)throw new Error('invalid_zip');
    const flags=u16(view,cursor+8),method=u16(view,cursor+10),compressed=u32(view,cursor+20),expanded=u32(view,cursor+24);
    const nameLength=u16(view,cursor+28),extraLength=u16(view,cursor+30),commentLength=u16(view,cursor+32),localOffset=u32(view,cursor+42);
    const name=decoder.decode(bytes.slice(cursor+46,cursor+46+nameLength)).replace(/\\/g,'/');
    cursor+=46+nameLength+extraLength+commentLength;
    if(flags&1)throw new Error('unsupported_zip');
    if(name.endsWith('/')||name.startsWith('/')||name.split('/').includes('..'))continue;
    total+=expanded;if(total>maxExpanded)throw new Error('zip_too_large');
    if(localOffset+30>bytes.length||u32(view,localOffset)!==0x04034b50)throw new Error('invalid_zip');
    const localName=u16(view,localOffset+26),localExtra=u16(view,localOffset+28),start=localOffset+30+localName+localExtra;
    if(start+compressed>bytes.length)throw new Error('invalid_zip');
    const payload=bytes.slice(start,start+compressed);
    let content;if(method===0)content=payload;else if(method===8)content=await inflate(payload,expanded);else throw new Error('unsupported_zip');
    if(content.length!==expanded)throw new Error('invalid_zip');
    files.set(name,content);
  }
  return files;
}

export async function unzipText(buffer,options) {
  const entries=await unzip(buffer,options),result=new Map();
  for(const [name,bytes] of entries)if(name.toLowerCase().endsWith('.csv'))result.set(name,decoder.decode(bytes));
  return result;
}
