// Explicit test-only binding: it adapts the existing response fixtures to the native run() shape.
// It never sends a network request; global fetch is replaced by each test before use.
export const simulatedWorkersAI=()=>({run:async(model,input)=>{
  const response=await fetch('https://simulated-workers-ai.invalid/run',{method:'POST',body:JSON.stringify({model,...input})});
  const body=await response.json().catch(()=>null);
  if(!response.ok)throw Object.assign(new Error(body?.error?.message||`simulated HTTP ${response.status}`),{status:response.status,code:body?.error?.code});
  return {response:body?.choices?.[0]?.message?.content??body?.response??'',finish_reason:body?.choices?.[0]?.finish_reason??body?.finish_reason??null,usage:body?.usage};
}});
