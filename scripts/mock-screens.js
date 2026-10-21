#!/usr/bin/env node
// Saves the README's and the release video's screenshots: npm run mock-screens -- [out-dir]
//
// Runs on the real device so the pictures are what the Car Thing draws, but feeds it fixture
// data instead of whatever is playing — one Thursday afternoon, the same on every run. The page is
// reloaded afterwards, which puts the live bridge data and input handlers back.
//
// Every shot has the album art background on, each over its own album, so the screens match the
// scenes of the Figma video (docs/1.0.0/README.md): the video's 1920×1080 backdrop for a scene is
// the same blurred image the device draws behind that screen. Albums with a cover go through
// native/bin/artwork as live album art does; the older scenes only have their backdrop, which is
// sent to the device as the already-blurred background.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../bridge/config.js';
import { adb, listCarThings } from '../bridge/device/adb.js';
import { CDP, listTargets } from '../bridge/device/cdp.js';
import { renderCover, SIZE } from '../bridge/widgets/perpetual.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.join(here, '..');
const out = process.argv[2] || path.join('docs', '1.0.0');
const art = (file) => path.join(root, 'docs', '1.0.0', 'artwork', file);
const artworkBin = path.join(root, 'native', 'bin', 'artwork');

const now = Date.UTC(2026, 9, 15, 13, 14); // Thursday 15 October, 1:14 PM (the page runs at UTC)
const HOUR = 3600000;
const DAY = 86400000;
const midnight = Date.UTC(2026, 9, 15);
const at = (day, hours) => midnight + day * DAY + hours * HOUR;

// A cover is what Now Playing shows; a background is the blurred image behind every screen.
// Albums without a cover are only ever behind other screens, so they play a stand-in track.
const albums = {
  pompeii: { cover: 'pompeii.jpg', background: 'catelebon.jpg', np: { artist: 'Cate Le Bon', title: 'Moderation', album: 'Pompeii', duration: 250, elapsed: 62 } },
  post: { cover: 'post.png', background: 'post.jpg', np: { artist: 'Björk', title: 'Hyperballad', album: 'Post', duration: 321, elapsed: 40 } },
  goodbye: { cover: 'goodbye-enemy-airship.jpg', background: 'goodbye.jpg', np: { artist: 'Do Make Say Think', title: 'When Day Chokes the Night', album: 'Goodbye Enemy Airship the Landlord Is Dead', duration: 398, elapsed: 50 } },
  ovlov: { cover: 'ovlov-am.jpg', background: 'ovlov.jpg', np: { artist: 'Ovlov', title: 'Where’s My Dini?', album: 'Am', duration: 264, elapsed: 66 } },
  ...Object.fromEntries(['artblakey', 'basic', 'deafheaven', 'getupkids', 'horselords', 'hug', 'ribbons', 'sanddollar', 'tomrogerson']
    .map((name) => [name, { background: `${name}.jpg` }])),
};

const settings = {
  theme: 'dark', units: 'F', clock24h: false, artBackground: true, clockFace: 'analog', calendarDays: 2,
  location: { mode: 'auto' }, usageSource: 'both', meetingAlert: 0, idleMinutes: 0,
};

const calendar = {
  status: 'ok',
  events: [
    { start: at(0, 17.5), end: at(0, 19), title: 'Dinner with Sam & Alex', location: 'Studio B', color: '#ff8b00', calendarId: 'mock' },
    { start: at(0, 19.5), end: at(0, 21), title: 'Book club', location: 'Studio B', color: '#bf5af2', calendarId: 'mock' },
    { start: at(1, 13), end: at(1, 14), title: 'Design review', color: '#30d158', calendarId: 'mock' },
  ],
};
const designSync = { start: at(0, 14), end: at(0, 14.5), title: 'Design sync', call: 'https://zoom.us/j/1234567890', color: '#30d158', calendarId: 'mock' };

const hour = (i, temp, code, isDay, pop) => ({ t: at(0, 13 + i), temp, code, isDay, pop });
const day = (i, code, pop, lo, hi) => ({ t: midnight + i * DAY, code, pop, lo, hi });
const weather = {
  status: 'ok', place: 'Portland', utcOffset: 0, updatedAt: now,
  current: { temp: 72, code: 0, isDay: true },
  hourly: [hour(0, 72, 0, true, 0), hour(1, 74, 0, true, 0), hour(2, 75, 1, true, 0), hour(3, 75, 2, true, 10), hour(4, 74, 2, true, 10), hour(5, 72, 2, true, 10), hour(6, 70, 2, false, 10), hour(7, 68, 3, false, 20), hour(8, 66, 3, false, 20), hour(9, 64, 3, false, 20), hour(10, 63, 3, false, 20)],
  daily: [day(0, 63, 55, 56, 77), day(1, 3, 0, 56, 77), day(2, 63, 55, 44, 63), day(3, 3, 0, 44, 77), day(4, 2, 10, 50, 72), day(5, 61, 40, 52, 68)],
};

// Usage: Claude's session a little under half used, resetting at 3:44; ChatGPT's in four hours.
// Both weeks reset Sunday morning.
const usage = { status: 'ok', updatedAt: now, session: { percent: 38, resetsAt: now + 2.5 * HOUR }, week: { percent: 64, resetsAt: at(3, 9) } };
const chatgptUsage = { status: 'ok', updatedAt: now, session: { percent: 28, resetsAt: now + 4 * HOUR }, week: { percent: 42, resetsAt: at(3, 9) } };

const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 20000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
const dataUrl = (buf, mime) => `data:${mime};base64,${buf.toString('base64')}`;

// Each album's artwork message, made the way the bridge makes it (bridge/nowplaying/artwork.js).
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-screens-'));
async function artwork(name) {
  const album = albums[name];
  const background = await fs.readFile(art(path.join('backgrounds', album.background)));
  const source = art(album.cover ? album.cover : path.join('backgrounds', album.background));
  const cover = path.join(tmp, `${name}.jpg`);
  const { tint } = JSON.parse(await run(artworkBin, [source, '480', cover, path.join(tmp, `${name}.blur.jpg`)]));
  return { type: 'artwork', key: `mock-${name}`, dataUrl: dataUrl(await fs.readFile(cover), 'image/jpeg'), blurUrl: dataUrl(background, 'image/jpeg'), tint };
}
// Nothing playing: the day's perpetual-calendar cover, as bridge/widgets/perpetual.js draws it.
async function perpetual() {
  const dayNumber = Math.floor(now / DAY);
  const png = path.join(tmp, 'perpetual.png');
  await fs.writeFile(png, await renderCover(dayNumber, tmp));
  const cover = path.join(tmp, 'perpetual.jpg'), blur = path.join(tmp, 'perpetual.blur.jpg');
  const { tint } = JSON.parse(await run(artworkBin, [png, String(SIZE), cover, blur]));
  return { status: 'ok', day: dayNumber, dataUrl: dataUrl(await fs.readFile(cover), 'image/jpeg'), blurUrl: dataUrl(await fs.readFile(blur), 'image/jpeg'), tint };
}

const [device] = await listCarThings();
if (!device) {
  console.error('No Car Thing found over adb');
  process.exit(1);
}
await adb(['forward', `tcp:${config.cdpPort}`, 'tcp:2222'], { serial: device.serial });
const page = (await listTargets(config.cdpPort)).find((t) => t.type === 'page');
const cdp = await CDP.connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const send = (msg) => evaluate(`window.__mockReceive(${JSON.stringify(msg)})`);
// The page's clock is held at the fixture time (see the CT.now override below), so countdowns
// read the same on every run; a tick message then updates whatever shows the time.
let time = now;
async function tick(ms = time) {
  time = ms;
  await evaluate(`window.__mockNow = ${ms}`);
  await send({ type: 'tick', now: ms, tzMinutes: 0 });
}
const press = (key) => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)}})); window.dispatchEvent(new KeyboardEvent('keyup', {key:${JSON.stringify(key)}}))`);
const turn = (clicks) => evaluate(`window.dispatchEvent(new WheelEvent('wheel', {deltaX:${53 * Math.sign(clicks)}, cancelable:true}))`);

let playing = null;
async function play(name) {
  if (playing === name) return;
  playing = name;
  const album = albums[name];
  const np = album.np || { artist: 'MacThing', title: name, album: name, duration: 240, elapsed: 60 };
  const message = await artwork(name);
  await send({ type: 'nowPlaying', np: { active: true, kind: 'music', ...np, rate: 1, playing: true, artworkKey: message.key } });
  await send(message);
  await pause(1500); // the art decodes and crossfades in; on the device that can take a while
}

// Each shot: its file, the album behind it, the screen, and how many more times that screen's
// button is pressed for the view (the weather's Today and This Week, the calendar's month, the
// clock's timer and usage). Screens keep their view between shots. `setup` runs before the screen
// comes up, `before` once it's up, and `after` once it's captured.
const shots = [
  { name: 'nowplaying', album: 'pompeii' },
  { name: 'nowplaying-post', album: 'post', screen: 'nowplaying' },
  { name: 'nowplaying-goodbye', album: 'goodbye', screen: 'nowplaying' },
  { name: 'nowplaying-ovlov', album: 'ovlov', screen: 'nowplaying' },
  { name: 'calendar', album: 'getupkids' },
  { name: 'calendar-month', album: 'tomrogerson', screen: 'calendar', reselect: 1 },
  { name: 'calendar-reminders', album: 'tomrogerson', screen: 'calendar', reselect: 1 },
  { name: 'weather', album: 'horselords' },
  { name: 'weather-today', album: 'sanddollar', screen: 'weather', reselect: 1 },
  { name: 'weather-week', album: 'ribbons', screen: 'weather', reselect: 1 },
  { name: 'clock', album: 'artblakey' },
  { name: 'clock-digital', album: 'artblakey', screen: 'clock', before: () => send({ type: 'settings', settings: { ...settings, clockFace: 'digital' } }),
    after: () => send({ type: 'settings', settings }) },
  // The timer opens at 15 minutes; two clicks of the knob make it 45. A press starts it, and the
  // countdown frames are 12:38 to 12:41 later — shot 0.6 s early, as a running timer ends on a half
  // second (timer.js endOnHalfSecond) and shows whole seconds rounded down.
  { name: 'timer', album: 'basic', screen: 'clock', reselect: 1, before: async () => { await pause(500); await turn(1); await turn(1); } },
  ...[22, 21, 20, 19].map((s) => ({
    name: `timer-countdown-32-${s}`, album: 'hug', screen: 'clock',
    before: async () => { if (s === 22) { await tick(now); await press('Enter'); } time = now + (12 * 60 + 60 - s) * 1000 - 600; },
  })),
  { name: 'timer-running', album: 'hug', screen: 'clock' },
  // Reset the timer; the next press of the clock button is Claude's usage, then ChatGPT's, then
  // back to the clock face.
  { name: 'claude', album: 'post', screen: 'clock', reselect: 1, setup: async () => { await press('Enter'); await press('Enter'); await pause(300); await tick(now); } },
  { name: 'chatgpt', album: 'goodbye', screen: 'clock', reselect: 1, after: () => evaluate('CT.screens.clock.reselect()') },
  { name: 'settings', album: 'deafheaven' },
  // The meeting alert three minutes before a 2 PM meeting, over Now Playing.
  { name: 'meeting-alert', album: 'pompeii', screen: 'nowplaying', before: async () => {
    await tick(at(0, 14) - 3 * 60000);
    await evaluate("localStorage.removeItem('ct-dismissed-meetings'); localStorage.removeItem('ct-queued-meeting')");
    await send({ type: 'settings', settings: { ...settings, meetingAlert: 5 } });
    await send({ type: 'calendar', calendar: { status: 'ok', events: [designSync, ...calendar.events] } });
  } },
  // Ten minutes into the meeting the clock's timer opens on its end; started, it shows 19:59.
  { name: 'meeting-timer', album: 'ovlov', screen: 'clock', reselect: 1,
    setup: async () => {
      await send({ type: 'settings', settings });
      await send({ type: 'calendar', calendar: { status: 'ok', events: [designSync] } });
      await tick(at(0, 14 + 10 / 60));
    },
    before: async () => { await pause(400); await tick(); await press('Enter'); time += 400; } }, // a second in, less the 0.6 s above
  // Nothing playing: the perpetual calendar in place of the art, and behind everything.
  { name: 'nowplaying-empty', screen: 'nowplaying', setup: async () => {
    await press('Enter'); await press('Enter');
    await send({ type: 'calendar', calendar });
    await tick(now);
    playing = null;
    await send({ type: 'nowPlaying', np: { active: false } });
    await pause(1500);
  } },
];

async function capture({ name, album, screen = name, reselect = 0, setup, before, after }) {
  if (album) await play(album);
  await tick(); // the page shows "Waiting for your Mac" after 6.5s without a message
  if (setup) await setup();
  await evaluate(`CT.show(${JSON.stringify(screen)})`);
  for (let i = 0; i < reselect; i++) await evaluate(`CT.screens.${screen}.reselect()`);
  if (before) await before();
  // Let screen switches (core.js clears .leaving when the new screen's fade-in ends) and view
  // fades (0.3 s out, then 0.5 s in) finish, then any font fitting settle.
  const busy = `!!document.querySelector('.screen.leaving, .view-enter-active, .view-leave-active')`;
  await pause(100);
  for (let i = 0; i < 30 && (await evaluate(busy)); i++) await pause(100);
  await pause(600);
  await tick();
  await pause(300);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const target = path.join(out, `${name}.png`);
  await fs.writeFile(target, Buffer.from(data, 'base64'));
  console.log(target);
  if (after) await after();
}

// Screens keep the view they were left on (the calendar's month, the clock's timer), so start
// from a fresh page with the default views.
await evaluate("localStorage.removeItem('ct-dismissed-meetings'); localStorage.removeItem('ct-queued-meeting'); sessionStorage.removeItem('ct-dev-screen')");
await cdp.send('Page.reload', { ignoreCache: true });
let mounted = false;
for (let i = 0; i < 30 && !mounted; i++) {
  await pause(500);
  mounted = await evaluate('!!window.CT && !!document.querySelector("#mount") && !!document.querySelector("#mount").__vue_app__').catch(() => false);
}

try {
  // Take the bridge's messages out of the page, so live data can't overwrite the fixtures.
  await evaluate('window.__mockReceive = window.__carthingReceive; window.__carthingReceive = function () {}; CT.send = function () {}');
  // Hold the page's clock still: it otherwise runs on from each tick, and a second's drift shows.
  // The fixture's times are UTC, so hold the page's timezone there too.
  await evaluate(`window.__mockNow = ${now}; CT.now = function () { return window.__mockNow; };
    var parts = CT.parts, dayNumber = CT.dayNumber;
    CT.parts = function (ms, tz) { return parts(ms, tz == null ? 0 : tz); };
    CT.dayNumber = function (ms, tz) { return dayNumber(ms, tz == null ? 0 : tz); };`);
  await send({ type: 'settings', settings });
  await send({ type: 'appearance', dark: true });
  await send({ type: 'screen', on: true });
  await tick();
  await send({ type: 'calendar', calendar });
  await send({ type: 'weather', weather });
  await send({ type: 'usage', usage });
  await send({ type: 'chatgptUsage', usage: chatgptUsage });
  await send({ type: 'perpetual', perpetual: await perpetual() });

  await fs.mkdir(out, { recursive: true });
  for (const shot of shots) await capture(shot);
} finally {
  await evaluate("localStorage.removeItem('ct-dismissed-meetings'); localStorage.removeItem('ct-queued-meeting')").catch(() => {});
  await cdp.send('Page.reload', { ignoreCache: true });
  cdp.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
