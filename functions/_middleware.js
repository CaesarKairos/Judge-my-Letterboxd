const MAINTENANCE_HTML=`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta name="theme-color" content="#101619">
  <title>Em manutenção — Judge My Letterboxd</title>
  <style>
    :root{color-scheme:dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#101619;color:#f2efdf}
    *{box-sizing:border-box}body{min-height:100svh;margin:0;display:grid;place-items:center;padding:24px}
    main{width:min(100%,560px);padding:clamp(28px,7vw,56px);border:1px solid #354247;border-radius:20px;background:#172125;text-align:center}
    .mark{margin:0 auto 28px;width:54px;height:4px;border-radius:9px;background:#e2a16b}
    p{margin:0;color:#c9c9bd;font-size:1rem;line-height:1.65}h1{margin:0 0 14px;font-size:clamp(2rem,8vw,3.25rem);line-height:1.05;letter-spacing:-.045em}
    .en{margin-top:22px;padding-top:20px;border-top:1px solid #354247;font-size:.92rem;color:#aeb7b4}
    footer{margin-top:32px;color:#879490;font-size:.75rem;letter-spacing:.16em;text-transform:uppercase}
  </style>
</head>
<body><main><div class="mark" aria-hidden="true"></div><h1>Voltamos em breve.</h1>
<p>O Judge My Letterboxd está passando por uma manutenção rápida. Tente novamente daqui a pouco.</p>
<p class="en" lang="en">Judge My Letterboxd is undergoing a short maintenance. Please check back soon.</p>
<footer>Judge My Letterboxd</footer></main></body></html>`;

const maintenancePage=(method)=>new Response(method==='HEAD'?null:MAINTENANCE_HTML,{
  status:503,
  headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store, max-age=0','Retry-After':'900','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow'}
});

const maintenanceApi=()=>Response.json({error:'maintenance',maintenance:true},{
  status:503,
  headers:{'Cache-Control':'no-store','Retry-After':'900','X-Content-Type-Options':'nosniff'}
});

export async function onRequest({request,env,next}){
  if(String(env?.JUDGE_MAINTENANCE_MODE??'').trim()!=='1')return next();
  const url=new URL(request.url);
  // Keep the health/config diagnostics available while visitor pages and action APIs are paused.
  if(request.method==='GET'&&['/api/config','/api/judge'].includes(url.pathname))return next();
  if(url.pathname.startsWith('/api/'))return maintenanceApi();
  return maintenancePage(request.method);
}
