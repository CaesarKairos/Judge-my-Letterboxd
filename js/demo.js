import {validateScript} from './utils.js';
export async function loadDemo(signal) {
  const response = await fetch('/data/demo-presentation.json', {signal});
  if (!response.ok) throw new Error('offline');
  return validateScript(await response.json());
}
