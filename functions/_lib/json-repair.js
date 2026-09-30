// One recovery implementation for every stage. A model reply cut by the output limit is
// still evidence: close the open string, drop the dangling separator and close every open
// object, then keep whatever still parses. Writer and Analyst share this code on purpose,
// so a fix here can never drift between the two stages.
export function salvageJson(text) {
  const raw = String(text || '').replace(/^[^{[]*/, '').replace(/```[\s\S]*$/, '').trim();
  try { return JSON.parse(raw); } catch {}
  const stack = []; let open = false, escaped = false, out = '', done = false;
  for (const char of raw) {
    if (open) {
      if (escaped) { escaped = false; out += char; continue; }
      if (char === '\\') { escaped = true; out += char; continue; }
      if (char === '"') { open = false; out += char; continue; }
      out += char === '\n' || char === '\r' ? ' ' : char; continue;
    }
    if (char === '"') { open = true; out += char; continue; }
    if (char === '{' || char === '[') { stack.push(char); out += char; continue; }
    if (char === '}' || char === ']') { stack.pop(); out += char; if (!stack.length) { done = true; break; } continue; }
    out += char;
  }
  // The object closed before the end: whatever follows is prose, not data.
  if (done) { try { return JSON.parse(out); } catch { return null; } }
  if (escaped) out = out.slice(0, -1);
  if (open) out += '"';
  out = out.replace(/[,:\s]+$/, '');
  // Inside an object a trailing bare string is a key without a value, so it is dropped;
  // inside an array it is a value cut by the limit, so it is kept.
  if (stack.at(-1) === '{') out = out.replace(/,\s*"[^"]*"\s*$/, '');
  while (stack.length) out = `${out.replace(/[\s,]+$/, '')}${stack.pop() === '{' ? '}' : ']'}`;
  try { return JSON.parse(out); } catch { return null; }
}

// A reply is interpreted once, here: the raw text, why the model stopped, the parsed value
// and whether the parser or the salvage path produced it. Stages decide what to do with it.
export function readModelReply(text, finishReason) {
  const reason = String(finishReason || 'STOP').toUpperCase();
  const truncated = reason !== 'STOP' && !reason.endsWith('_STOP');
  const value = String(text || '');
  if (!value) return { reason, truncated, parsed: null, salvage_used: false, parse_error: 'empty_response' };
  try {
    return { reason, truncated, parsed: JSON.parse(value), salvage_used: false, parse_error: null };
  } catch (error) {
    const parsed = salvageJson(value);
    return { reason, truncated, parsed, salvage_used: Boolean(parsed), parse_error: error.message };
  }
}

// The attempt record exists so a failure can be explained from the logs alone. A reply cut by
// the output limit is truncated_output, never a generic invalid_response.
export function attemptStatus({ status, ok, reply }) {
  if (!ok) return { 400: 'http_400', 401: 'http_401', 403: 'http_403', 404: 'http_404', 413: 'http_413', 429: 'http_429' }[status] || (status >= 500 ? `http_${status}` : 'http_error');
  if (!reply) return 'invalid_response';
  if (reply.truncated) return 'truncated_output';
  if (!reply.parsed) return 'invalid_response';
  if (reply.salvage_used) return 'salvaged_output';
  return null;
}
