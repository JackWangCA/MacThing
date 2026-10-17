import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const script = new URL('../device/sleepd.sh', import.meta.url).pathname;

// Runs the real watchdog against files in a temp folder: the backlight switch, the heartbeat and
// the input marker are all plain files, and supervisorctl and the USB gadget simply aren't there.
async function startSleepd(dir) {
  const files = { bl: path.join(dir, 'bl'), hb: path.join(dir, 'hb'), mark: path.join(dir, 'input') };
  await fs.writeFile(files.bl, '1\n');
  await fs.writeFile(
    path.join(dir, 'sleep.conf'),
    [`BL=${files.bl}`, `HB=${files.hb}`, `MARK=${files.mark}`, 'IDLE=3', 'POLL=1', 'HEAL=0', 'POWERSAVE=0'].join('\n') + '\n',
  );
  const proc = spawn('sh', [script], { env: { ...process.env, SLEEPD_CONF: path.join(dir, 'sleep.conf') }, stdio: 'ignore' });
  return { files, proc };
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const backlight = async (f) => (await fs.readFile(f.bl, 'utf8')).trim();

test('a stale "off" at handover is corrected by the next heartbeat', { timeout: 20000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'macthing-sleepd-test-'));
  const { files, proc } = await startSleepd(dir);
  try {
    // No Mac: the watchdog puts the screen to sleep.
    await waitFor(async () => (await backlight(files)) === '0', 8000, 'sleep');

    // The bridge comes back and lights the screen, but the beat sleepd hands over on is a stale
    // "off" — what happened after a Mac sleep/wake on 2026-10-17.
    await fs.writeFile(files.bl, '1\n');
    await fs.writeFile(files.hb, '1 off\n');
    await waitFor(async () => (await backlight(files)) === '0', 3000, 'handover off');

    // The bridge's next beat says what it really set.
    await fs.writeFile(files.hb, '2 on\n');
    await waitFor(async () => (await backlight(files)) === '1', 3000, 'backlight back on');

    // From then on the bridge owns the screen again: a later "off" is the bridge's to apply.
    await fs.writeFile(files.hb, '3 off\n');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await backlight(files), '1');
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.on('exit', r));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
