const FORMATS={post:{width:1080,height:1350,label:'post'},story:{width:1080,height:1920,label:'story'}};
const wrap=(ctx,text,width)=>{const words=String(text||'').split(/\s+/),lines=[];let line='';for(const word of words){const next=(line+' '+word).trim();if(ctx.measureText(next).width>width&&line){lines.push(line);line=word;}else line=next;}if(line)lines.push(line);return lines;};
const load=url=>new Promise(resolve=>{if(!url)return resolve(null);const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>resolve(null);image.src=url;});
const text=(ctx,value,x,y,width,lineHeight,max=9)=>{let row=y;for(const line of wrap(ctx,value,width).slice(0,max)){ctx.fillText(line,x,row);row+=lineHeight;}return row;};
const proxy=url=>url?'/api/image-proxy?url='+encodeURIComponent(url):'';
const common=(script,format)=>{
 const size=FORMATS[format]||FORMATS.post,canvas=document.createElement('canvas');canvas.width=size.width;canvas.height=size.height;
 const ctx=canvas.getContext('2d');ctx.fillStyle='#101619';ctx.fillRect(0,0,size.width,size.height);ctx.fillStyle='#caff83';ctx.fillRect(0,0,size.width,12);
 ctx.fillStyle='#caff83';ctx.font='24px monospace';ctx.textAlign='left';ctx.fillText('JUDGE MY LETTERBOXD',72,format==='story'?110:86);
 ctx.fillStyle='#eef3ed';ctx.font='32px Arial';ctx.fillText('@'+(script.profile?.handle||'letterboxd'),72,format==='story'?178:150);
 // Branding detail replaces the removed avatar/initials.
 ctx.beginPath();for(let i=0;i<3;i++){ctx.arc(size.width-150+i*30,format==='story'?105:80,8,0,Math.PI*2);}ctx.fillStyle='#caff83';ctx.fill();
 return {canvas,ctx,size};
};
async function archetypeCard(script,format,posterUrls){
 const {canvas,ctx,size}=common(script,format),phrase=script.opening?.archetype_text||'',story=format==='story';
 ctx.fillStyle='#eef3ed';ctx.font='30px Arial';ctx.fillText(story?'O SEU TOP 4 PRODUZIU ISTO:':'VOCÊ DEVE SER O...',72,story?330:255);
 ctx.fillStyle='#caff83';ctx.font=story?'bold 92px Georgia':'bold 78px Georgia';const phraseEnd=text(ctx,phrase||'UM CASO DIFÍCIL',72,story?455:350,900,story?104:88,story?8:6);
 const films=script.opening?.top_four||[],posters=await Promise.all(posterUrls.slice(0,4).map(url=>load(proxy(url))));
 if(story){
   const w=310,h=465,gap=38,startX=(size.width-(w*2+gap))/2,startY=Math.max(900,phraseEnd+110);
   films.slice(0,4).forEach((film,index)=>{const x=startX+(index%2)*(w+gap),y=startY+Math.floor(index/2)*(h+42);ctx.fillStyle=['#354749','#6c513c','#4f5f3f','#485675'][index];ctx.fillRect(x,y,w,h);if(posters[index])ctx.drawImage(posters[index],x,y,w,h);else{ctx.fillStyle='#eef3ed';ctx.font='bold 30px Georgia';text(ctx,film.title,x+22,y+320,w-44,36,4);}});
   ctx.fillStyle='#9fa9a4';ctx.font='24px Arial';ctx.fillText('Quatro favoritos. Uma especificidade desnecessária.',72,size.height-90);
 }else{
   const w=202,h=300,y=820;films.slice(0,4).forEach((film,index)=>{const x=72+index*234;ctx.fillStyle=['#354749','#6c513c','#4f5f3f','#485675'][index];ctx.fillRect(x,y,w,h);if(posters[index])ctx.drawImage(posters[index],x,y,w,h);else{ctx.fillStyle='#eef3ed';ctx.font='bold 24px Georgia';text(ctx,film.title,x+15,y+220,w-30,28,3);}});
   ctx.fillStyle='#9fa9a4';ctx.font='22px Arial';ctx.fillText('Pode ser só @'+(script.profile?.handle||'você')+'.',72,1235);
 }
 return canvas;
}
function profileReviewCard(script,format){
 const {canvas,ctx,size}=common(script,format),story=format==='story',profile=script.profile_review||{};
 ctx.fillStyle='#9fa9a4';ctx.font=story?'30px Arial':'28px Arial';ctx.fillText('SE EU FALASSE DE VOCÊ COMO VOCÊ FALA DOS FILMES...',72,story?360:255);
 ctx.fillStyle='#eef3ed';ctx.font=story?'58px Georgia':'48px Georgia';text(ctx,profile.share||profile.full||profile.text||'O julgamento acabou antes desta review.',72,story?510:350,900,story?76:62,story?15:12);
 ctx.fillStyle='#caff83';ctx.font='22px monospace';ctx.fillText(story?'PROFILE REVIEW · STORY 9:16':'PROFILE REVIEW · POST 4:5',72,size.height-82);
 return canvas;
}
export async function makeShareCards(script,{format='post',posterUrls=[]}={}){
 return {archetype:await archetypeCard(script,format,posterUrls),profile_review:profileReviewCard(script,format)};
}
export const cardBlob=canvas=>new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
export function downloadCard(canvas,name){canvas.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name+'.png';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},'image/png');}
export {FORMATS};
