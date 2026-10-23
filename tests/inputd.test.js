import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';

const script = new URL('../device/inputd.sh', import.meta.url).pathname;

// A raw evdev record as this device's 32-bit userland lays it out: timeval (2 x 32-bit), type,
// code, value.
const event = (type, code, value) => {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(type, 8);
  b.writeUInt16LE(code, 10);
  b.writeInt32LE(value, 12);
  return b;
};
const SYN = event(0, 0, 0);
const key = (code, value) => Buffer.concat([event(1, code, value), SYN]);
const wheel = (value) => Buffer.concat([event(2, 6, value), SYN]);

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

/** Runs the real daemon against a FIFO standing in for /dev/input/eventN. */
async function withDaemon(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'macthing-inputd-test-'));
  const fifo = path.join(dir, 'event0');
  execFileSync('mkfifo', [fifo]);
  const port = await freePort();
  const proc = spawn('sh', [script], {
    env: { ...process.env, INPUTD_CONF: path.join(dir, 'none'), INPUTD_PORT: String(port), INPUTD_DEVICES: fifo },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // Opening the FIFO for writing blocks until the daemon opens it for reading.
  const writer = await fs.open(fifo, 'w');
  await new Promise((resolve) => proc.stdout.on('data', (d) => String(d).includes('serving') && resolve()));
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const got = [];
  ws.onmessage = (m) => got.push(JSON.parse(m.data));
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  try {
    await body({ write: (b) => writer.write(b), got, settle: () => new Promise((r) => setTimeout(r, 150)) });
  } finally {
    ws.close();
    await writer.close();
    proc.kill();
    await new Promise((r) => proc.on('exit', r));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('buttons and the knob come through as the keys core.js already uses', { timeout: 20000 }, () =>
  withDaemon(async ({ write, got, settle }) => {
    await write(Buffer.concat([key(2, 1), key(2, 0), key(5, 1), key(5, 2), key(5, 0)]));
    await write(Buffer.concat([key(1, 1), key(28, 1), key(50, 1), wheel(1), wheel(-1)]));
    await settle();
    assert.deepEqual(got, [
      { k: '1', v: 1 }, { k: '1', v: 0 },
      { k: '4', v: 1 }, { k: '4', v: 2 }, { k: '4', v: 0 },
      { k: 'Escape', v: 1 }, { k: 'Enter', v: 1 }, { k: 'm', v: 1 },
      { w: 1 }, { w: -1 },
    ]);
  }));

test('a record split across reads is put back together, and other keys are ignored', { timeout: 20000 }, () =>
  withDaemon(async ({ write, got, settle }) => {
    const press = key(3, 1);
    await write(press.subarray(0, 7));
    await settle();
    await write(Buffer.concat([press.subarray(7), key(116, 1)])); // 116: the power key, not ours
    await settle();
    assert.deepEqual(got, [{ k: '2', v: 1 }]);
  }));
