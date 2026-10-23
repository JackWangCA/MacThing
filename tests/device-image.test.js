import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { parseBootUrl } from '../bridge/device/deploy.js';

const UI = '/var/lib/carthing/ui';
const out = (app, link = '') => `${app}\r\n--8<--\r\n${link}\r\n`;

test('an imaged device boots the UI folder directly', () => {
  assert.equal(parseBootUrl(out('--app=file:///var/lib/carthing/ui/index.html'), UI), 'file:///var/lib/carthing/ui/index.html');
});

test('a patched device boots Spotify\'s web app path, linked to the UI folder', () => {
  const url = 'file:///usr/share/qt-superbird-app/webapp/index.html';
  assert.equal(parseBootUrl(out(`--app=${url}`, UI), UI), url);
});

test('stock Spotify is not our UI', () => {
  assert.equal(parseBootUrl(out('--app=file:///usr/share/qt-superbird-app/webapp/index.html'), UI), null);
  assert.equal(parseBootUrl(out(''), UI), null);
});

test("the image's supervisord.conf boots our UI and has none of Spotify's programs", async () => {
  const conf = await fs.readFile(new URL('../device/supervisord.conf', import.meta.url), 'utf8');
  const programs = [...conf.matchAll(/^\[program:([^\]]+)\]/gm)].map((m) => m[1]);
  assert.deepEqual(programs.sort(), ['backlight', 'bluetoothd', 'carthing-input', 'carthing-sleep', 'chromium', 'earlyoom']);
  assert.match(conf, /--app=file:\/\/\/var\/lib\/carthing\/ui\/index\.html/);
  assert.match(conf, /^command=\/bin\/sh \/var\/lib\/carthing\/dimmerd\.sh$/m);
  assert.doesNotMatch(conf, /superbird|swupdate|sp-als-backlight/);
  // Bluetooth stays installed but doesn't start.
  assert.match(conf.split('[program:bluetoothd]')[1].split('\n[')[0], /^autostart=false$/m);
});
