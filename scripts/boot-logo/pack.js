#!/usr/bin/env node
// Puts a new boot picture into a copy of the Car Thing's logo partition.
//
//   node scripts/boot-logo/pack.js <logo.img> <portrait.rgba> <out.img> [entry]
//
// The partition is an Amlogic resource pack ("AML_RES!"): a table of named entries, each a BMP with
// its own CRC32, which U-boot reads with `imgread pic logo <name>` and shows with `bmp display`. The
// one shown at boot is `bootup_spotify`. The new picture replaces that entry's pixels in place, in
// the entry's own BMP format (480x800, 16-bit RGB565, bottom-up), so the size, offset and every
// other entry stay exactly as they were, and only its CRC changes.
import fs from 'node:fs';
import { crc32 } from 'node:zlib';

const [src, rgbaPath, out, entry = 'bootup_spotify'] = process.argv.slice(2);
if (!out) {
  console.error('usage: pack.js <logo.img> <portrait.rgba> <out.img> [entry]');
  process.exit(2);
}
const img = fs.readFileSync(src);
const rgba = fs.readFileSync(rgbaPath);
const fail = (msg) => { console.error(msg); process.exit(1); };

if (img.toString('latin1', 8, 16) !== 'AML_RES!') fail(`${src} isn't an Amlogic logo pack`);
const count = img.readUInt32LE(0x14);
const entries = [];
for (let i = 0; i < count; i++) {
  const h = 0x40 + i * 0x40;
  entries.push({ h, size: img.readUInt32LE(h + 8), off: img.readUInt32LE(h + 12), crc: img.readUInt32LE(h + 24), name: img.toString('latin1', h + 0x20, h + 0x40).replace(/\0.*$/s, '') });
}
const e = entries.find((x) => x.name === entry) || fail(`no "${entry}" in ${src} (has ${entries.map((x) => x.name).join(', ')})`);
for (const x of entries) if (crc32(img.subarray(x.off, x.off + x.size)) !== x.crc) fail(`"${x.name}" fails its CRC already; not touching this pack`);

const bmp = img.subarray(e.off, e.off + e.size);
const dataOff = bmp.readUInt32LE(10), width = bmp.readInt32LE(18), height = bmp.readInt32LE(22), bpp = bmp.readUInt16LE(28);
const masks = [bmp.readUInt32LE(54), bmp.readUInt32LE(58), bmp.readUInt32LE(62)];
if (bmp.toString('latin1', 0, 2) !== 'BM' || bpp !== 16 || masks.join() !== [0xf800, 0x07e0, 0x001f].join())
  fail(`"${entry}" isn't the 16-bit RGB565 BMP this expects`);
const rows = Math.abs(height), stride = Math.ceil((width * 2) / 4) * 4;
if (rgba.length !== width * rows * 4) fail(`${rgbaPath} is ${rgba.length} bytes; a ${width}x${rows} picture is ${width * rows * 4}`);
if (dataOff + stride * rows > e.size) fail(`"${entry}" is too small for its own pixels`);

const pack = Buffer.from(img);
const pixels = pack.subarray(e.off + dataOff, e.off + dataOff + stride * rows);
pixels.fill(0);
for (let y = 0; y < rows; y++) {
  const row = height > 0 ? rows - 1 - y : y; // a positive height stores the bottom row first
  for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    const v = ((rgba[p] >> 3) << 11) | ((rgba[p + 1] >> 2) << 5) | (rgba[p + 2] >> 3);
    pixels.writeUInt16LE(v, row * stride + x * 2);
  }
}
pack.writeUInt32LE(crc32(pack.subarray(e.off, e.off + e.size)), e.h + 24);
fs.writeFileSync(out, pack);
console.log(`• "${entry}" replaced (${width}x${rows}); ${entries.length - 1} other entries untouched`);
