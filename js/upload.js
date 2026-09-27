import {$} from './utils.js';
import {t} from './i18n.js';
export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export async function validateFile(file) {
  if (!file || !/\.zip$/i.test(file.name)) throw new Error('zip');
  if (file.size > MAX_FILE_SIZE) throw new Error('large');
  const b = new Uint8Array(await file.slice(0,4).arrayBuffer());
  if (b[0] !== 80 || b[1] !== 75 || !((b[2]===3&&b[3]===4)||(b[2]===5&&b[3]===6)||(b[2]===7&&b[3]===8))) throw new Error('zip');
  return file;
}
export function setupUpload() {
  let file = null, revision = 0;
  const input = $('#export'), zone = $('#dropzone');
  const clear = () => { revision++; file=null; input.value=''; $('#selected').hidden=true; $('#judge').disabled=true; };
  async function select(candidate) {
    const current = ++revision;
    try {
      const valid = await validateFile(candidate); if(current!==revision)return;
      file=valid; $('#file-name').textContent=file.name; $('#file-size').textContent=`${(file.size/1024/1024).toFixed(2)} MB`;
      $('#selected').hidden=false; $('#judge').disabled=false; $('#upload-error').textContent='';
    } catch(error) { if(current!==revision)return; clear(); $('#upload-error').textContent=t(error.message); }
  }
  input.addEventListener('change', () => select(input.files[0]));
  zone.addEventListener('dragover', e => {e.preventDefault();zone.classList.add('dragging');});
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', e => {e.preventDefault();zone.classList.remove('dragging');select(e.dataTransfer.files[0]);});
  $('#remove').addEventListener('click', clear);
  return {get file(){return file;}, clear};
}
