import {validateScript} from './utils.js';
export async function judgeExport(file, locale, signal) {
  const form = new FormData(); form.append('export', file); form.append('locale', locale);
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(abort, 120000);
  try {
    const response = await fetch('/api/judge', {method:'POST', body:form, signal:controller.signal});
    if (!response.ok) throw new Error(({404:'unavailable',501:'unavailable',429:'rate',413:'large'})[response.status] || 'server');
    let data; try { data = await response.json(); } catch { throw new Error('invalid'); }
    return validateScript(data);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('timeout');
    if (error instanceof TypeError) throw new Error('offline');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
