import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { moneyRound, moneyText, paceK, paceNumber, SESSION_MS } from '../ui/src/usage.js';

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
  assert.equal(paceNumber(window(99, .01), SESSION_MS, now), '891x');
  assert.equal(paceNumber(window(97, .99), SESSION_MS, now), '0.3x');
  assert.equal(paceNumber({percent: 0, resetsAt: null}, SESSION_MS, now), '0.0x');
  assert.equal(paceNumber(window(0, .5), SESSION_MS, now), '0.0x');
  // Half used with 4.5% of the time left is about 0.047x: any use shows at least 0.1x, not 0.0x.
  assert.equal(paceNumber(window(50, 1 - 7.5 / 168), SESSION_MS, now), '0.1x');
  assert.equal(paceNumber(window(0.1, .9), SESSION_MS, now), '0.1x');
  assert.equal(paceNumber(window(10, .5), SESSION_MS, now), '0.1x');
  assert.equal(paceNumber(window(100, .5), SESSION_MS, now), '🔥🔥🔥');
  assert.equal(paceNumber(window(110, .5), SESSION_MS, now), '🔥🔥🔥');
});

test('money reads as dollars and cents, whatever float the spend arrives as', () => {
  // The device's Chromium drops toLocaleString's options, so this must not rely on them.
  assert.equal(moneyText(382.39000000000004), '$382.39', 'a summed float keeps two places');
  assert.equal(moneyText(12.4), '$12.40');
  assert.equal(moneyText(0), '$0.00');
  assert.equal(moneyText(2200), '$2,200.00');
  assert.equal(moneyText(1234567.891), '$1,234,567.89', 'grouped every three digits');
  assert.equal(moneyText(999), '$999.00', 'and not before');
  assert.equal(moneyText(-5.5), '-$5.50', 'the sign goes outside the dollar');
  assert.equal(moneyText(-1234.5), '-$1,234.50');
  assert.equal(moneyText(null), '–');
  assert.equal(moneyText(NaN), '–');
});

test('the rail drops the cents, which is what keeps a big spend inside the rail', () => {
  assert.equal(moneyRound(382.39000000000004), '$382');
  assert.equal(moneyRound(12345.67), '$12,346', 'rounded, not truncated');
  assert.equal(moneyRound(0), '$0');
  assert.equal(moneyRound(-1234.5), '-$1,235');
  assert.equal(moneyRound(null), '–');
});
