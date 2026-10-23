import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { burnK, paceK, paceNumber, SESSION_MS } from '../ui/src/usage.js';

test('legacy label choices are ignored and cannot be selected', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'macthing-settings-test-'));
  try {
    const folder = path.join(home,'Library','Application Support','carthing-now-playing');
    await fs.mkdir(folder,{recursive:true});
    await fs.writeFile(path.join(folder,'settings.json'),JSON.stringify({usageLabels:'emoji',usageSource:'both'}));
    const module = new URL('../bridge/settings.js',import.meta.url).href;
    const source = `import assert from 'node:assert/strict';
      const {settings} = await import(${JSON.stringify(module)});
      assert.equal(settings.get().usageLabels,undefined);
      assert.equal(settings.get().usageSource,'both');
      for(const usageLabels of ['words','emoji','k']) assert.equal(settings.update({usageLabels}),false);`;
    await promisify(execFile)(process.execPath,['--input-type=module','-e',source],{env:{...process.env,HOME:home}});
  } finally { await fs.rm(home,{recursive:true,force:true}); }
});

test('numeric labels use the actual K ratio and the elapsed-time floor', () => {
  const now = 1800000000000;
  const window = (percent, elapsed) => ({percent, resetsAt: now + SESSION_MS * (1 - elapsed)});
  const sample = window(22, .2);
  assert.ok(Math.abs(paceK(sample, SESSION_MS, now) - (22 / 78) / (.2 / .8)) < 1e-9);
  assert.equal(paceNumber(sample, SESSION_MS, now), '1.1x');
  assert.equal(paceNumber(window(42, .56), SESSION_MS, now), '0.6x');
  assert.equal(paceNumber(window(99, .01), SESSION_MS, now), '891x 🔥🔥');
  // 1.9x stays calm; from 2x the decimal goes and a fire comes, from 4x two.
  assert.equal(paceNumber(window(32, .2), SESSION_MS, now), '1.9x');
  assert.equal(paceNumber(window(33.3, .2), SESSION_MS, now), '2x 🔥');
  assert.equal(paceNumber(window(38, .2), SESSION_MS, now), '2x 🔥');
  assert.equal(paceNumber(window(45, .2), SESSION_MS, now), '3x 🔥');
  assert.equal(paceNumber(window(50, .2), SESSION_MS, now), '4x 🔥🔥');
  assert.equal(paceNumber(window(97, .99), SESSION_MS, now), '0.3x');
  assert.equal(paceNumber({percent: 0, resetsAt: null}, SESSION_MS, now), '0.0x');
  assert.equal(paceNumber(window(0, .5), SESSION_MS, now), '0.0x');
  // Half used with 4.5% of the time left is about 0.047x: any use shows at least 0.1x, not 0.0x.
  assert.equal(paceNumber(window(50, 1 - 7.5 / 168), SESSION_MS, now), '0.1x');
  assert.equal(paceNumber(window(0.1, .9), SESSION_MS, now), '0.1x');
  assert.equal(paceNumber(window(10, .5), SESSION_MS, now), '0.1x');
  assert.equal(paceNumber(window(100, .5), SESSION_MS, now), '💀');
  assert.equal(paceNumber(window(110, .5), SESSION_MS, now), '💀');
});

test('a hot burn right now brings fires to a calm pace', () => {
  const now = 1800000000000;
  // 40% used with 60% of the session gone is 0.4x overall, with 60% left to spend in 2h: 30%/h.
  const w = burn => ({ percent: 40, resetsAt: now + SESSION_MS * .4, burn });
  // 15% in 15 minutes is 60%/h, 2x the affordable pace.
  assert.ok(Math.abs(burnK(w({ percent: 15, ms: 15 * 60000 }), now, now) - 2) < 1e-9);
  assert.equal(paceNumber(w(), SESSION_MS, now, now), '0.4x');
  assert.equal(paceNumber(w({ percent: 4, ms: 15 * 60000 }), SESSION_MS, now, now), '0.4x');
  assert.equal(paceNumber(w({ percent: 15, ms: 15 * 60000 }), SESSION_MS, now, now), '0.4x 🔥');
  assert.equal(paceNumber(w({ percent: 30, ms: 15 * 60000 }), SESSION_MS, now, now), '0.4x 🔥🔥');
  // A burn measured more than 20 minutes ago, or a label without updatedAt (the week), stays calm.
  assert.equal(paceNumber(w({ percent: 30, ms: 15 * 60000 }), SESSION_MS, now, now - 21 * 60000), '0.4x');
  assert.equal(paceNumber(w({ percent: 30, ms: 15 * 60000 }), SESSION_MS, now), '0.4x');
  // A hot window keeps its own fires when the burn is calmer.
  assert.equal(paceNumber({ ...w({ percent: 1, ms: 15 * 60000 }), percent: 80 }, SESSION_MS, now, now), '3x 🔥');
});
