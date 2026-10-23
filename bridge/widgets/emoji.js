import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../log.js';

const DIR = path.join(os.homedir(), 'Library', 'Application Support', 'carthing-now-playing', 'emoji');
const SCRIPT = fileURLToPath(new URL('./emoji.jxa.js', import.meta.url));
// Part of each cached file's name: bump it when emoji.jxa.js draws differently.
const VERSION = 2;

/**
 * The Mac's own Apple emoji for the device, which has no emoji font: each one drawn once with
 * Apple Color Emoji (emoji.jxa.js), kept as a PNG in Application Support, and returned as
 * {emoji: data URL}. An emoji that can't be drawn is left out, and the device uses its bundled
 * Twemoji instead (RailText.vue). Nothing is drawn while Apple's artwork stays on this Mac.
 */
export async function macEmoji(list, { dir = DIR, size = 128, render = renderEmoji } = {}) {
  const out = {};
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  for (const emoji of list) {
    const file = path.join(dir, `${[...emoji].map(c => c.codePointAt(0).toString(16)).join('-')}-${size}-v${VERSION}.png`);
    try {
      let png = await fs.readFile(file).catch(() => null);
      if (!png) { await render(emoji, file, size); png = await fs.readFile(file); }
      out[emoji] = `data:image/png;base64,${png.toString('base64')}`;
    } catch (err) {
      log.warn('[emoji]', `could not draw ${emoji}: ${err.message}`);
    }
  }
  return out;
}

function renderEmoji(emoji, file, size) {
  return new Promise((resolve, reject) =>
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', SCRIPT, emoji, file, String(size)], { timeout: 15000 },
      err => (err ? reject(err) : resolve())));
}
