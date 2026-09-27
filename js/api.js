import {validateScript} from './utils.js';
export async function judgeExport(file, locale, signal) {
  const form = new FormData(); form.append('export', file); form.append('locale', locale);
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(abort, 120000);
  try {
    const response = await fetch('/api/judge', {method:'POST', body:form, signal:controller.signal});
    if (!response.ok) {
      let reason='';try{reason=(await response.json()).error||'';}catch{}
      const known={missing_gemini_key:'configuration',invalid_zip:'zip',unsupported_zip:'zip',not_letterboxd_export:'exportFormat',empty_export:'emptyExport',file_too_large:'large',gemini_rate_limit:'rate',gemini_failure:'server',gemini_invalid_response:'invalid'};
      throw new Error(known[reason]||({404:'unavailable',501:'unavailable',503:'configuration',429:'rate',413:'large',422:'exportFormat'})[response.status]||'server');
    }
    let data; try { data = await response.json(); } catch { throw new Error('invalid'); }
    return validateScript(data);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('timeout');
    if (error instanceof TypeError) throw new Error('offline');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
