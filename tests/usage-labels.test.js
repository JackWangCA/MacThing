import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paceLevel, paceImage, SESSION_MS } from '../ui/src/usage.js';

test('all seven pace levels have the requested distinct offline emoji', async () => {
  const now = 1800000000000;
  for (const [percent, label, asset] of [[10,'Good','1f44d'],[20,'OK','1f44c'],[28,'Ahead','1f44e'],[45,'High','270b'],[80,'Severe','1f525'],[97,'Max','1f4a5'],[100,'Over','1f6ab']]) {
    const level = paceLevel({percent,resetsAt:now+SESSION_MS*.8},SESSION_MS,now);
    assert.equal(level,label);
    const image = paceImage(level,'emoji');
    assert.equal(image,'images/emoji/'+asset+'.svg');
    assert.match(await fs.readFile(new URL('../ui/'+image,import.meta.url),'utf8'), /<svg/);
    assert.equal(paceImage(level,'words'),null);
    assert.equal(paceImage(level,undefined),null);
  }
  assert.equal(paceImage('--','emoji'),null);
});

test('usage label preference defaults to words, persists, and rejects invalid values', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'macthing-settings-test-'));
  try {
    // The real settings module runs in a subprocess with an isolated HOME; never edits the user's preferences.
    const module = new URL('../bridge/settings.js',import.meta.url).href;
    const source = `import assert from 'node:assert/strict';
      const {settings} = await import(${JSON.stringify(module)});
      assert.equal(settings.get().usageLabels,'words');
      assert.equal(settings.update({usageLabels:'emoji'}),true);
      assert.equal(settings.get().usageLabels,'emoji');
      assert.equal(settings.update({usageLabels:'invalid'}),false);
      const {settings:loaded} = await import(${JSON.stringify(module+'?reload')});
      assert.equal(loaded.get().usageLabels,'emoji');
      loaded.update({usageLabels:'words'});
      assert.equal(loaded.get().usageLabels,'words');`;
    await promisify(execFile)(process.execPath,['--input-type=module','-e',source],{env:{...process.env,HOME:home}});
  } finally { await fs.rm(home,{recursive:true,force:true}); }
});
