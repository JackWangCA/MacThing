import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { coverSvg, renderCover, PALETTE, SIZE } from '../bridge/widgets/perpetual.js';

test('a day always draws the same cover, and the next day a different one', () => {
  assert.equal(coverSvg(20746), coverSvg(20746));
  assert.notEqual(coverSvg(20746), coverSvg(20747));
  assert.equal(coverSvg(20746).match(/<path /g).length, 6);
});

test('each panel takes a different colour from the palette, every day', () => {
  for (let day = 20000; day < 20400; day++) {
    const fills = coverSvg(day).match(/<path [^>]*fill="([^"]+)"/g).map((p) => p.match(/fill="([^"]+)"/)[1]);
    assert.equal(new Set(fills).size, 6, 'day ' + day);
    assert.ok(fills.every((f) => PALETTE.includes(f)));
  }
});

test('the top colour and the top shape never repeat two days running', () => {
  const tops = (day) => { const fills = [...coverSvg(day).matchAll(/<path d="([^"]+)" fill="([^"]+)"/g)]; return fills[fills.length - 1].slice(1, 3); };
  let prev = tops(19999);
  for (let day = 20000; day < 21000; day++) {
    const now = tops(day);
    assert.notEqual(now[0], prev[0], 'shape, day ' + day);
    assert.notEqual(now[1], prev[1], 'colour, day ' + day);
    prev = now;
  }
});

test('Quick Look renders the cover as a stage-sized PNG', { skip: process.platform !== 'darwin' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'macthing-perpetual-test-'));
  try {
    const png = await renderCover(20746, dir);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), SIZE); // IHDR width
    assert.equal(png.readUInt32BE(20), SIZE); // IHDR height
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
