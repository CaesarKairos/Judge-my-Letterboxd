// Explicit boundary until the Python service is connected. Never consume uploads here.
export function onRequestPost() {
  return Response.json({error:'web_backend_not_connected'},{status:501,headers:{'Cache-Control':'no-store'}});
}
