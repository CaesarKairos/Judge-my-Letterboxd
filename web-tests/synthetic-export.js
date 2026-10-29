const encoder=new TextEncoder();
const concat=parts=>{const size=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(size);let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;};
const record=(size,write)=>{const bytes=new Uint8Array(size);write(new DataView(bytes.buffer));return bytes;};
export const syntheticFiles={
  'profile.csv':'Username,Name,Favorite Films\nfictionalcritic,Fictional Critic,"https://boxd.it/a, https://boxd.it/b, https://boxd.it/c, https://boxd.it/d"\n',
  'ratings.csv':'Name,Year,Letterboxd URI,Rating\nAlpha,2000,https://boxd.it/a,5\nBeta,2001,https://boxd.it/b,4.5\nGamma,2002,https://boxd.it/c,4.5\nDelta,2003,https://boxd.it/d,4\n',
  'reviews.csv':'Name,Year,Letterboxd URI,Rating,Review\nAlpha,2000,https://boxd.it/a,5,Uma review fictícia.\n',
  'diary.csv':'Name,Year,Letterboxd URI,Rating,Watched Date,Tags\nAlpha,2000,https://boxd.it/a,5,2026-01-01,fictício\n'
};
export function syntheticZip(files=syntheticFiles){
  const locals=[],central=[];let offset=0;
  for(const [name,text] of Object.entries(files)){
    const n=encoder.encode(name),data=encoder.encode(text);
    const header=record(30,v=>{v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,n.length,true);});
    locals.push(header,n,data);
    const directory=record(46,v=>{v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);v.setUint32(20,data.length,true);v.setUint32(24,data.length,true);v.setUint16(28,n.length,true);v.setUint32(42,offset,true);});
    central.push(directory,n);offset+=header.length+n.length+data.length;
  }
  const centralBytes=concat(central),end=record(22,v=>{v.setUint32(0,0x06054b50,true);v.setUint16(8,Object.keys(files).length,true);v.setUint16(10,Object.keys(files).length,true);v.setUint32(12,centralBytes.length,true);v.setUint32(16,offset,true);});
  return concat([...locals,centralBytes,end]);
}
