const ALLOWED=new Set(['image.tmdb.org']);
const headers={'Cache-Control':'public, max-age=604800, s-maxage=2592000, immutable','X-Content-Type-Options':'nosniff'};
export async function onRequestGet({request}){
  let target;try{target=new URL(new URL(request.url).searchParams.get('url')||'');}catch{return new Response('invalid_url',{status:400});}
  if(target.protocol!=='https:'||!ALLOWED.has(target.hostname))return new Response('forbidden',{status:403});
  const upstream=await fetch(target.toString(),{headers:{Accept:'image/avif,image/webp,image/jpeg'}});
  if(!upstream.ok)return new Response('image_unavailable',{status:upstream.status});
  const type=upstream.headers.get('Content-Type')||'';if(!/^image\/(jpeg|png|webp|avif)$/i.test(type))return new Response('invalid_image',{status:415});
  return new Response(upstream.body,{headers:{...headers,'Content-Type':type}});
}
