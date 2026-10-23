import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';

const pack = new URL('../scripts/boot-logo/pack.js', import.meta.url).pathname;
const W = 4, H = 2; // tiny stand-ins for the real 480x800

// A 16-bit RGB565 BMP laid out like the device's: 138-byte header, positive height (bottom-up).
function bmp(fill) {
  const stride = W * 2, b = Buffer.alloc(138 + stride * H);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(138, 10);
  b.writeUInt32LE(124, 14);
  b.writeInt32LE(W, 18);
  b.writeInt32LE(H, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(16, 28);
  b.writeUInt32LE(3, 30);
  [0xf800, 0x07e0, 0x001f].forEach((m, i) => b.writeUInt32LE(m, 54 + i * 4));
  for (let i = 138; i < b.length; i += 2) b.writeUInt16LE(fill, i);
  return b;
}

// An AML_RES! pack with the entries the device has, each a BMP with its CRC.
function logoPack(names) {
  const bmps = names.map((_, i) => bmp(0x1111 * (i + 1)));
  const out = Buffer.alloc(0x100 + bmps.reduce((n, b) => n + b.length, 0));
  out.write('AML_RES!', 8, 'latin1');
  out.writeUInt32LE(names.length, 0x14);
  let off = 0x100;
  names.forEach((name, i) => {
    const h = 0x40 + i * 0x40;
    out.writeUInt32LE(0x27051956, h);
    out.writeUInt32LE(bmps[i].length, h + 8);
    out.writeUInt32LE(off, h + 12);
    out.writeUInt32LE(crc32(bmps[i]), h + 24);
    out.write(name, h + 0x20, 'latin1');
    bmps[i].copy(out, off);
    off += bmps[i].length;
  });
  return out;
}

test('the boot picture replaces only its own entry, with a valid CRC', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'macthing-logo-test-'));
  try {
    const src = logoPack(['bad_charger', 'bootup_spotify', 'burn_mode']);
    const rgba = Buffer.alloc(W * H * 4);
    // Top-left pixel pure red, the rest white.
    for (let p = 0; p < rgba.length; p += 4) rgba.set(p === 0 ? [255, 0, 0, 255] : [255, 255, 255, 255], p);
    await fs.writeFile(path.join(dir, 'logo.img'), src);
    await fs.writeFile(path.join(dir, 'p.rgba'), rgba);
    await promisify(execFile)(process.execPath, [pack, path.join(dir, 'logo.img'), path.join(dir, 'p.rgba'), path.join(dir, 'out.img')]);
    const out = await fs.readFile(path.join(dir, 'out.img'));

    assert.equal(out.length, src.length);
    const entry = (i) => ({ size: out.readUInt32LE(0x40 + i * 0x40 + 8), off: out.readUInt32LE(0x40 + i * 0x40 + 12), crc: out.readUInt32LE(0x40 + i * 0x40 + 24) });
    for (const i of [0, 1, 2]) {
      const e = entry(i);
      assert.equal(crc32(out.subarray(e.off, e.off + e.size)), e.crc, `entry ${i} CRC`);
    }
    for (const i of [0, 2]) {
      const e = entry(i);
      assert.deepEqual(out.subarray(e.off, e.off + e.size), src.subarray(e.off, e.off + e.size), `entry ${i} untouched`);
    }
    // Bottom-up: the picture's top row is the BMP's last row.
    const e = entry(1), topRow = e.off + 138 + (H - 1) * W * 2;
    assert.equal(out.readUInt16LE(topRow), 0xf800, 'red top-left');
    assert.equal(out.readUInt16LE(topRow + 2), 0xffff, 'white beside it');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a pack whose entries already fail their CRC is left alone', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'macthing-logo-test-'));
  try {
    const src = logoPack(['bootup_spotify']);
    src[0x100 + 140] ^= 0xff; // damage the pixels without fixing the CRC
    await fs.writeFile(path.join(dir, 'logo.img'), src);
    await fs.writeFile(path.join(dir, 'p.rgba'), Buffer.alloc(W * H * 4));
    await assert.rejects(promisify(execFile)(process.execPath, [pack, path.join(dir, 'logo.img'), path.join(dir, 'p.rgba'), path.join(dir, 'out.img')]), /fails its CRC/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
