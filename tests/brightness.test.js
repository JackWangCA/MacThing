import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const script = new URL('../device/dimmerd.sh', import.meta.url).pathname;

/**
 * Runs the real auto-brightness daemon against plain files in a temp folder: the backlight level,
 * the power switch and the light sensor are all just files it reads and writes, so nothing here
 * needs a device.
 */
async function startDimmer(dir, { bias = 0, als = 580 } = {}) {
  const files = {
    bl: path.join(dir, 'bl'),
    power: path.join(dir, 'power'),
    sensor: path.join(dir, 'als'),
    conf: path.join(dir, 'dimmer.conf'),
  };
  await fs.writeFile(files.bl, '100\n');
  await fs.writeFile(files.power, '1\n');
  await fs.writeFile(files.sensor, `${als}\n`);
  await writeConf(files, bias);
  const proc = spawn('sh', [script], {
    env: {
      ...process.env,
      DIMMER_CONF: files.conf,
      DIMMER_BL: files.bl,
      DIMMER_POWER: files.power,
      DIMMER_SENSOR: files.sensor,
    },
    stdio: 'ignore',
  });
  return { files, proc };
}

// DELAY of 1 so the dim window doesn't make the test wait out the real 10 seconds.
const writeConf = (files, bias) =>
  fs.writeFile(files.conf, [`DELAY=1`, `POLL=1`, `BIAS=${bias}`, `STEP=25`].join('\n') + '\n');

const level = async (files) => Number((await fs.readFile(files.bl, 'utf8')).trim());

async function settlesAt(files, want, what) {
  const end = Date.now() + 8000;
  let seen = null;
  while (Date.now() < end) {
    seen = await level(files);
    if (seen === want) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${what}: wanted ${want}, the backlight sat at ${seen}`);
}

async function withDimmer(options, body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'macthing-dimmer-test-'));
  const { files, proc } = await startDimmer(dir, options);
  try {
    await body(files);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.on('exit', r));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// A raw sensor reading of 580 sits between the curve's "576:74" and "604:73" entries, so the
// curve alone asks for 74 — which is what the real device reads in a normally lit room.
const LIT = 580;
const CURVE_AT_LIT = 74;

test('with no brightness offset the curve is exactly what it always was', { timeout: 20000 }, async () =>
  withDimmer({ bias: 0, als: LIT }, async (files) => {
    await settlesAt(files, CURVE_AT_LIT, 'an unbiased room');
  }));

// What each notch comes to at CURVE_AT_LIT. A notch is a share of the distance left to that end
// of the 1..235 range, so going brighter it is worth 25% of 74 - 1 and going dimmer 25% of
// 235 - 74, in the daemon's own truncating arithmetic: 73 * 25 / 100 is 18, not 18.25.
const AT_LIT = { '-2': 154, '-1': 114, 0: 74, 1: 56, 2: 38 };

test('a positive offset is brighter, a negative one dimmer', { timeout: 20000 }, async () => {
  // Lower is brighter on this panel, so "brighter" means a smaller number.
  await withDimmer({ bias: 2, als: LIT }, async (files) => {
    await settlesAt(files, AT_LIT[2], 'brightest');
  });
  await withDimmer({ bias: -2, als: LIT }, async (files) => {
    await settlesAt(files, AT_LIT[-2], 'dimmest');
  });
});

test('auto-brightness still follows the room at a non-zero offset', { timeout: 20000 }, async () =>
  withDimmer({ bias: 1, als: LIT }, async (files) => {
    await settlesAt(files, AT_LIT[1], 'a lit room, one notch brighter');
    // The room goes dark. The curve's bottom entry is 13:200, and the offset rides along with it
    // rather than being a fixed number of levels bolted on at one end.
    await fs.writeFile(files.sensor, '13\n');
    await settlesAt(files, 151, 'a dark room keeps the same offset'); // 200 - (200-1)*25/100
  }));

test('changing the offset moves the screen without waiting out the hold window', { timeout: 20000 }, async () =>
  withDimmer({ bias: 0, als: LIT }, async (files) => {
    await settlesAt(files, CURVE_AT_LIT, 'the starting level');
    // DELAY is 1s here but 10s in the field. The point is that this lands on the next poll
    // because it is the setting changing, not the room.
    await writeConf(files, 2);
    await settlesAt(files, AT_LIT[2], 'the new offset');
  }));

test('stepping through the offsets does not compound', { timeout: 30000 }, async () =>
  // Each notch is worked out from the curve's own level, not from the level already on screen, so
  // walking up and back lands exactly where it started.
  withDimmer({ bias: 0, als: LIT }, async (files) => {
    await settlesAt(files, CURVE_AT_LIT, 'the starting level');
    for (const bias of [1, 2, 1, 0, -1, -2, 0]) {
      await writeConf(files, bias);
      await settlesAt(files, AT_LIT[bias], `offset ${bias}`);
    }
  }));

test('the offset cannot push the backlight outside the panel range', { timeout: 20000 }, async () =>
  // Below the curve's first entry the level is already DARKEST (235). Measuring a notch from that
  // end rather than from the level is what keeps it inside: there is no room left to give, so the
  // dimmest setting is worth nothing here. A share of the level would have asked for 349.
  withDimmer({ bias: -2, als: 1 }, async (files) => {
    await settlesAt(files, 235, 'dimmest in an already dark room');
  }));

test('the brightness setting only accepts the five notches', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'macthing-brightness-test-'));
  try {
    const folder = path.join(home, 'Library', 'Application Support', 'carthing-now-playing');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'settings.json'), JSON.stringify({ brightness: 7 }));
    const module = new URL('../bridge/settings.js', import.meta.url).href;
    const source = `import assert from 'node:assert/strict';
      const {settings} = await import(${JSON.stringify(module)});
      assert.equal(settings.get().brightness, 0, 'an out-of-range saved value falls back to the default');
      for (const brightness of [-2, -1, 1, 2]) assert.equal(settings.update({brightness}), true);
      for (const brightness of [3, -3, 1.5, '2', null, true]) assert.equal(settings.update({brightness}), false);`;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, HOME: home } });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
