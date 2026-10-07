import {validateScript} from './utils.js';
export async function judgeExport(file, locale, signal) {
  const form = new FormData(); form.append('export', file); form.append('locale', locale);
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(abort, 210000);
  try {
    const response = await fetch('/api/judge', {method:'POST', body:form, signal:controller.signal});
    if (!response.ok) {
      let body={};try{body=await response.json();}catch{}
      const reason=body.error||'';
      const known={missing_gemini_key:'configuration',AI_FAILED:'aiUnavailable',freeform_context_too_large:'freeformTooLarge',ai_unavailable:'aiUnavailable',writer_unavailable:'writerUnavailable',analyst_unavailable:'analystUnavailable',invalid_zip:'zip',unsupported_zip:'zip',not_letterboxd_export:'exportFormat',empty_export:'emptyExport',file_too_large:'large',gemini_rate_limit:'rate',gemini_failure:'server',gemini_invalid_response:'modelInvalid'};
      // A stage failure caused by the quota or by a rate limit is a waiting problem, not a
      // "the Judge could not read you" problem: the copy has to say the true thing.
      const waiting={quota_exceeded:'quota',rate_limited:'rate'}[body.reason];
      const error=new Error(waiting||known[reason]||({404:'unavailable',501:'unavailable',503:'configuration',429:'rate',413:'large',422:'exportFormat'})[response.status]||'server');
      error.payload=body;throw error;
    }
    let data; try { data = await response.json(); } catch { throw new Error('invalid'); }
    return validateScript(data);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('timeout');
    if (error instanceof TypeError) throw new Error('offline');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
