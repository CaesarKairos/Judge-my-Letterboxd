import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';

test('browser module graph never imports the unpublished functions directory',()=>{
  const sources=readdirSync('js').filter(name=>name.endsWith('.js')).map(name=>[name,readFileSync(`js/${name}`,'utf8')]);
  const leaking=sources.filter(([,source])=>/from\s+['"]\.\.\/functions\//.test(source)).map(([name])=>name);
  assert.deepEqual(leaking,[]);
  assert.match(readFileSync('functions/_lib/csv.js','utf8'),/\.\.\/\.\.\/js\/csv\.js/);
});
