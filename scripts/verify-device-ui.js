// Smoke-test the compiled UI in the actual Chromium 69 kiosk. Fixture messages
// stay on the page; outgoing messages are captured, never sent to the Mac.
// Reloading in finally restores the live bridge data and input handlers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { config } from '../bridge/config.js';
import { adb, listCarThings } from '../bridge/device/adb.js';
import { CDP, listTargets } from '../bridge/device/cdp.js';

const [device] = await listCarThings();
assert(device, 'Connect a Car Thing first');
await adb(['forward', 'tcp:' + config.cdpPort, 'tcp:2222'], { serial: device.serial });
const target = (await listTargets(config.cdpPort)).find(t => t.type === 'page');
const cdp = await CDP.connect(target.webSocketDebuggerUrl);
const errors = [];
cdp.on('Runtime.exceptionThrown', e => errors.push(e.exceptionDetails.text + ': ' + (e.exceptionDetails.exception?.description || '')));
await cdp.send('Runtime.enable');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const output = await fs.mkdtemp('/tmp/carthing-vue-');
async function capture(name) {
  await pause(400);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(output + '/' + name + '.png', Buffer.from(shot.data, 'base64'));
}
async function message(msg) {
  await evaluate('window.fixtureReceive(' + JSON.stringify(msg) + ')');
  await pause(100);
}
// The page keeps the least-delayed of the last 15 ticks, so set the time with all 15.
async function tick(ms) {
  for (let i = 0; i < 15; i++) await evaluate('window.fixtureReceive(' + JSON.stringify({ type: 'tick', now: ms, tzMinutes: 0 }) + ')');
  await pause(100);
}
// npm run dev puts back the screen and view you were on (the weather's Today, the calendar's
// month…). Start from a fresh page with the default views, and put yours back afterwards.
const devScreen = await evaluate('sessionStorage.getItem("ct-dev-screen")');
await evaluate('sessionStorage.removeItem("ct-dev-screen")');
// The meeting alert keeps dismissed meetings across reloads, and reads them as the page loads. The
// last run's fixture meetings would still be dismissed under the fixture clock, so the cards this
// run expects wouldn't come up: drop those (only those) before the reload.
await evaluate(`(function () {
  var key = 'ct-dismissed-meetings', all = {};
  try { all = JSON.parse(localStorage.getItem(key)) || {}; } catch (e) {}
  Object.keys(all).forEach(function (k) { if (k.indexOf('fixture|') === 0) delete all[k]; });
  localStorage.setItem(key, JSON.stringify(all));
  if ((localStorage.getItem('ct-queued-meeting') || '').indexOf('fixture|') === 0) localStorage.removeItem('ct-queued-meeting');
})()`);
await cdp.send('Page.reload', { ignoreCache: true });
await pause(500);
try {
  let mounted = false;
  for (let attempt = 0; attempt < 30 && !mounted; attempt++) {
    mounted = await evaluate('!!window.CT && !!document.querySelector("#mount") && !!document.querySelector("#mount").__vue_app__').catch(() => false);
    if (!mounted) await pause(500);
  }
  assert.equal(mounted, true, 'Vue mounted');
  await evaluate('window.fixtureReceive = window.__carthingReceive; window.__carthingReceive = function(){}; window.fixtureSent = []; CT.send = function(msg){window.fixtureSent.push(msg)}');
  // A settings message replaces the whole object, so anything left out here renders as its first
  // option. For most rows that is also the default and the screenshot still reads true; brightness
  // is the one whose default sits in the middle of its options, so it has to be named.
  const settings = { theme: 'dark', clock24h: false, artBackground: false, clockFace: 'analog', calendarDays: 2, brightness: 0, location: { mode: 'auto' } };
  await message({ type: 'settings', settings });
  await message({ type: 'screen', on: true });
  await tick(Date.UTC(2026, 8, 22, 14, 35));
  const now = Date.UTC(2026, 8, 22, 14, 35);
  await message({ type: 'nowPlaying', np: { active: true, title: 'A very long title that needs to fit within the available left rail without hiding the album or the progress bar', artist: 'Example artist', album: 'Example album', duration: 300, elapsed: 100, playing: true, rate: 1, artworkKey: null } });
  await evaluate("CT.show('nowplaying')");
  await capture('nowplaying-long');
  assert.equal(await evaluate('(function(){var c=document.querySelector("#screen-nowplaying .left-rail-content");return c.lastElementChild.getBoundingClientRect().bottom <= c.getBoundingClientRect().bottom + 1})()'), true, 'Long track fits rail');
  const artwork = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="#15536b"/><circle cx="320" cy="160" r="130" fill="#d89951"/></svg>').toString('base64');
  await message({ type: 'settings', settings: { ...settings, artBackground: true } });
  await message({ type: 'nowPlaying', np: { active: true, artist: 'Example artist', title: 'A short title', album: 'Example album', artworkKey: 'fixture-art', duration: 300, elapsed: 60, rate: 0, playing: false } });
  await message({ type: 'artwork', key: 'fixture-art', dataUrl: artwork });
  await capture('artwork-paused');
  assert.equal(await evaluate('document.getElementById("app").classList.contains("ambient-on")'), true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".paused-glyph")).opacity'), '1');
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter'})); window.dispatchEvent(new KeyboardEvent('keyup', {key:'Enter'}))");
  await pause(450);
  assert.equal(await evaluate('window.fixtureSent.some(m => m.type === "command" && m.action === "playpause")'), true, 'Knob press sends playpause');
  assert.equal(await evaluate('document.getElementById("screen-nowplaying").classList.contains("paused")'), false);
  await message({ type: 'favorite', favorited: true });
  await capture('favorite');
  assert.equal(await evaluate('document.querySelector(".flash use").getAttribute("href")'), '#i-heart', 'Favoriting flashes the heart, with no toast');
  assert.equal(await evaluate('document.querySelector(".toast").textContent'), '');
  await message({ type: 'skip', action: 'next' });
  assert.equal(await evaluate('document.querySelector(".flash use").getAttribute("href")'), '#i-next', 'A skip made on the Mac flashes on the device');
  await message({ type: 'settings', settings });
  await message({ type: 'perpetual', perpetual: { status: 'ok', day: 20718, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' } });
  await message({ type: 'nowPlaying', np: { active: false } });
  await capture('idle');
  assert.match(await evaluate('document.querySelector("#screen-nowplaying .left-rail").textContent'), /September\s*22\s*Tuesday\s*2:35/, 'Nothing playing: the date and time');
  assert.equal(await evaluate('!!document.querySelector("#screen-nowplaying .np-placeholder")'), false, 'and the perpetual cover in place of the art');
  await message({ type: 'weather', weather: { status: 'noLocation', reason: 'denied' } });
  await evaluate("CT.show('weather')");
  await capture('weather-denied');
  assert.match(await evaluate('document.querySelector("#screen-weather").textContent'), /Location access is off/);
  await message({ type: 'weather', weather: { status: 'ok', place: 'Falmouth', utcOffset: 0, updatedAt: now, current: { temp: 68, code: 2, isDay: true }, hourly: Array.from({ length: 11 }, (_, i) => ({ t: now + i * 3600000, temp: 68 - i, code: 2, isDay: true, pop: 30 })), daily: Array.from({ length: 5 }, (_, i) => ({ t: now + i * 86400000, lo: 45 + i, hi: 68 + i, code: 3, pop: 40 })) } });
  await capture('weather');
  assert.equal(await evaluate('document.querySelectorAll(".w-day").length'), 4);
  assert.equal(await evaluate('document.querySelector(".w-hourly").children.length'), 5);
  // The weather button on the weather steps through today's hours, the week, and back.
  const weatherButton = () => evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'3'})); window.dispatchEvent(new KeyboardEvent('keyup', {key:'3'}))");
  await weatherButton();
  await capture('weather-today');
  assert.equal(await evaluate('document.querySelectorAll("#screen-weather .w-row").length'), 6, 'The weather button lists the hours');
  assert.match(await evaluate('document.querySelector("#screen-weather .w-rows").textContent'), /^2PM\s*30%/);
  await weatherButton();
  await capture('weather-week');
  assert.equal(await evaluate('document.querySelectorAll("#screen-weather .w-week .w-row").length'), 5, 'then the days');
  await weatherButton();
  await pause(400); // the week fades out (0.3 s) before it leaves the page
  assert.equal(await evaluate('!!document.querySelector("#screen-weather .w-rows")'), false, 'and back to the forecast');
  await message({ type: 'calendar', calendar: { status: 'denied' } });
  await evaluate("CT.show('calendar')");
  await capture('calendar-denied');
  assert.match(await evaluate('document.querySelector("#screen-calendar").textContent'), /Calendar access is off/);
  await message({ type: 'calendar', calendar: { status: 'ok', events: Array.from({ length: 14 }, (_, i) => ({ start: now + (i + 1) * 3600000, end: now + (i + 2) * 3600000, title: 'Example event ' + (i + 1), location: 'An event location', color: '#ff8b00', allDay: false })) } });
  await capture('calendar-full');
  assert.equal(await evaluate('(function(){var l=document.querySelector(".k-list");return l.scrollHeight <= l.clientHeight})()'), true, 'Agenda fits stage');
  assert.equal(await evaluate('document.querySelector(".calendar-time").textContent'), '2:35', 'Calendar shows current time');
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'2'})); window.dispatchEvent(new KeyboardEvent('keyup', {key:'2'}))");
  await capture('calendar-month');
  assert.match(await evaluate('document.querySelector("#screen-calendar .k-month").textContent'), /September.*22.*30/, 'The calendar button shows the month');
  assert.equal(await evaluate('document.querySelector("#screen-calendar .k-today").textContent.trim()'), '22');
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', {key:'2'})); window.dispatchEvent(new KeyboardEvent('keyup', {key:'2'}))");
  await pause(400); // the month fades out (0.3 s) before it leaves the page
  assert.equal(await evaluate('!!document.querySelector("#screen-calendar .k-month")'), false, 'and back to the agenda');
  await evaluate("CT.show('clock')");
  await capture('clock');
  assert.match(await evaluate('document.querySelector("#screen-clock .left-rail").textContent'), /3:35 PM.*Example event 1/);
  // The clock button on the clock steps to the timer, then the usage Settings → Usage asks for (Claude
  // by default); the knob sets, runs and resets the timer.
  const press = key => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'${key}'})); window.dispatchEvent(new KeyboardEvent('keyup', {key:'${key}'}))`);
  const rail = () => evaluate('document.querySelector("#screen-clock .left-rail-view.on").textContent');
  const clockView = () => evaluate('document.querySelector("#screen-clock .left-rail-view.on").getAttribute("data-view")');
  async function toClock() {
    while (await clockView() !== 'clock') await press('4');
    await pause(400);
  }
  await toClock(); // start from the clock
  await press('4');
  await pause(400); // the clock's text fades out (0.3 s) before the timer's is the only one
  await evaluate("window.dispatchEvent(new WheelEvent('wheel', {deltaX:53, cancelable:true}))");
  await pause(100);
  assert.match(await rail(), /30 minute timer30:00/, 'Wheel picks the timer length');
  await press('Enter');
  await tick(now + 754000);
  await pause(1100);
  assert.match(await rail(), /30 minute timer1[67]:\d\d/, 'Timer counts down');
  await capture('timer');
  await message({ type: 'usage', usage: { status: 'ok', session: { percent: 42, resetsAt: now + 754000 + 133 * 60000 }, week: { percent: 86, resetsAt: Date.UTC(2026, 8, 24, 9) }, updatedAt: now + 754000 } });
  await press('4');
  await pause(400); // the timer fades out (0.3 s)
  assert.equal(await clockView(), 'claude', 'The clock button goes on to Claude usage');
  assert.equal(await evaluate('window.fixtureSent.some(m => m.type === "refreshUsage")'), true, 'Opening usage asks the Mac for fresh numbers');
  // The session (42% used, 56% of its time gone) is under pace; the week (86%, 75%) is twice it.
  assert.match(await rail(), /Session: 42% used\s*0\.6x\s*Week: 2\.\dx · 86%/);
  // In place of the next event: the session resets in 2 h 13 min, the week on Thursday at 9.
  assert.match(await evaluate('document.querySelector("#screen-clock .left-rail > .flex-none").textContent'), /^Resets: Session 2h · Week 2d$/);
  // The session (42% used, 56% of its time gone) is behind its pace; the week (86%, 75%) is ahead of it.
  assert.equal(await evaluate('document.querySelectorAll("#screen-clock .u-over").length'), 1, 'Usage past the pace takes the accent');
  assert.equal(await evaluate('document.querySelectorAll("#screen-clock .u-pace").length'), 2, 'Both usage windows mark their pace with a dot');
  assert.equal(await evaluate('document.querySelectorAll("#screen-clock .u-behind").length'), 0, 'Under-pace usage leaves the track clear');
  assert.equal(await evaluate('Array.from(document.querySelectorAll("#screen-clock .u-label")).map(l => l.textContent).join()'), 'S,W', 'Each ring is named');
  await capture('usage');
  await message({ type: 'usage', usage: { status: 'ok', session: { percent: 0, resetsAt: null }, week: { percent: 0, resetsAt: null }, updatedAt: now } });
  assert.match(await evaluate('document.querySelector("#screen-clock .left-rail > .flex-none").textContent'), /^Resets: Session 5h · Week 7d$/);
  assert.equal(await evaluate('Array.from(document.querySelectorAll("#screen-clock .u-pace")).every(d => Number(d.getAttribute("cx")) === 240 && Number(d.getAttribute("cy")) < 240)'), true, 'Unstarted windows mark their pace at 12 o’clock');
  assert.equal(await evaluate('document.querySelectorAll("#screen-clock .u-pace").length'), 2, 'Unstarted windows keep both pace dots');
  await capture('usage-unstarted');
  await message({ type: 'usage', usage: { status: 'ok', session: { percent: 100, resetsAt: now + 3600000 }, week: { percent: 100, resetsAt: now + 86400000 }, updatedAt: now } });
  assert.equal(await evaluate('Array.from(document.querySelectorAll("#screen-clock .left-rail-view.on .rail-fires img")).filter(img => img.complete && img.naturalWidth > 0).length'), 6, 'Session and week each show three bundled fires at the limit');
  await capture('usage-limit');
  await message({ type: 'usage', usage: { status: 'expired' } });
  assert.match(await evaluate('document.querySelector("#screen-clock .stage-message").textContent'), /Claude sign-in expired/);
  await capture('usage-expired');
  await message({ type: 'usage', usage: { status: 'rateLimited', retryAt: now + 754000 + 5 * 60000 } });
  assert.match(await evaluate('document.querySelector("#screen-clock .fade-view.on .stage-message").textContent'), /Claude usage delayed.*Retrying in 5m/);
  assert.equal(await evaluate('document.querySelector("#screen-clock .fade-view.on .u-status-logo").getAttribute("aria-label")'), 'Claude logo');
  await capture('usage-rate-limited');
  // Settings → Usage → Both adds ChatGPT's view after Claude's: Codex's limits the same way, the
  // session (82%, 80% of it gone) just over pace, the week (10%, 32% gone) under it.
  await message({ type: 'settings', settings: { ...settings, usageSource: 'both' } });
  await message({ type: 'chatgptUsage', usage: { status: 'ok', session: { percent: 82, resetsAt: now + 754000 + 60 * 60000 }, week: { percent: 10, resetsAt: Date.UTC(2026, 8, 27, 9) }, updatedAt: now } });
  await press('4');
  await pause(400);
  assert.equal(await clockView(), 'chatgpt', 'With Both, the clock button goes on to ChatGPT usage');
  assert.equal(await evaluate('document.querySelector("#screen-clock .fade-view.on .u-face").getAttribute("aria-label")'), 'ChatGPT usage');
  assert.match(await rail(), /Session: 82% used\s*1\.1x\s*Week: 0\.2x · 10%/);
  assert.match(await evaluate('document.querySelector("#screen-clock .left-rail > .flex-none").textContent'), /^Resets: Session 1h · Week 5d$/);
  await capture('usage-chatgpt');
  await message({ type: 'chatgptUsage', usage: { status: 'none' } });
  assert.match(await evaluate('document.querySelector("#screen-clock .fade-view.on .stage-message").textContent'), /Codex isn’t on this Mac/);
  await message({ type: 'chatgptUsage', usage: { status: 'signedOut' } });
  assert.match(await evaluate('document.querySelector("#screen-clock .fade-view.on .stage-message").textContent'), /Not signed in to ChatGPT/);
  await press('4');
  await pause(400);
  assert.equal(await clockView(), 'clock', 'and then back to the clock');
  // Usage → None: the clock button only swaps the clock and the timer.
  await message({ type: 'settings', settings: { ...settings, usageSource: 'none' } });
  await press('4');
  await pause(400);
  await press('4');
  await pause(400);
  assert.equal(await clockView(), 'clock', 'With Usage → None there is no usage view');
  await message({ type: 'settings', settings });
  await press('4');
  await pause(400);
  await press('Enter'); await press('Enter');
  await pause(100);
  assert.match(await rail(), /30 minute timer30:00/, 'Double press resets');
  await toClock();
  await tick(now);
  // Past 60 minutes, the knob's meeting stop counts to the next meeting's start, in minutes
  // (rounded up) until it's started: 9:49 to go reads 10 min.
  await message({ type: 'calendar', calendar: { status: 'ok', events: [{ start: now + 589000, end: now + 2389000, title: 'Standup', color: '#2d9cdb', allDay: false, calendarId: 'fixture' }] } });
  await press('4');
  await pause(400);
  for (let i = 0; i < 7; i++) await evaluate("window.dispatchEvent(new WheelEvent('wheel', {deltaX:53, cancelable:true}))");
  await pause(100);
  assert.match(await rail(), /Next meeting in10\s*min/, 'Past 60 minutes: the next meeting\'s start');
  await press('Enter'); await press('Enter');
  await toClock();
  // During a meeting the timer opens set to its end, and runs to it.
  await message({ type: 'calendar', calendar: { status: 'ok', events: [{ start: now - 600000, end: now + 1200000, title: 'Standup', color: '#2d9cdb', allDay: false, calendarId: 'fixture' }] } });
  await press('4');
  await pause(400);
  assert.match(await rail(), /Standup20\s*min/, 'The timer opens on the meeting\'s end');
  await evaluate("window.dispatchEvent(new WheelEvent('wheel', {deltaX:-53, cancelable:true}))");
  await pause(100);
  assert.match(await rail(), /1 hour timer60:00/, 'Turning left goes back to the presets');
  await evaluate("window.dispatchEvent(new WheelEvent('wheel', {deltaX:53, cancelable:true}))");
  await pause(100);
  await press('Enter');
  await tick(now + 600000);
  await pause(1100);
  assert.match(await rail(), /Standup9:5\d/, 'The meeting timer counts down to its end');
  await press('Enter'); await press('Enter');
  await toClock();
  await tick(now);
  // With "Event's alert", a meeting with no alert of its own gets the card as it starts, and
  // nothing but its Start timer brings the timer up.
  await evaluate("CT.show('weather')");
  await message({ type: 'settings', settings: { ...settings, meetingAlert: 'event' } });
  await tick(now + 5000);
  await pause(1100);
  assert.equal(await evaluate('!!document.querySelector(".meeting-alert.on .m-start")'), true, 'An event without its own alert gets the card');
  assert.equal(await evaluate('CT.current'), 'weather', 'and the timer doesn\'t come up by itself');
  await press('1');
  await message({ type: 'settings', settings });
  await evaluate("CT.show('clock')");
  await tick(now);
  // Meeting alerts: a sheet over the screen from before a meeting to its end; any press only
  // dismisses it.
  await evaluate("localStorage.removeItem('ct-dismissed-meetings')");
  await message({ type: 'settings', settings: { ...settings, meetingAlert: 5 } });
  await message({ type: 'calendar', calendar: { status: 'ok', events: [{ start: now + 180000, end: now + 1980000, title: 'Example meeting', location: 'Room 4\n1 Example St', color: '#2d9cdb', allDay: false, calendarId: 'fixture' }] } });
  await capture('meeting-alert');
  // The card's text without the back button's part, which is checked on its own.
  const cardDetails = '(function(){var c=document.querySelector(".m-card").cloneNode(true);c.querySelector(".m-start").remove();return c.textContent})()';
  assert.match(await evaluate(cardDetails), /^\s*Example meeting.*2:38 – 3:08 PM.*Room 4.*In 3 min\s*$/, 'Meeting alert shows the meeting');
  assert.equal(await evaluate('document.querySelector(".m-card .m-start").textContent'), 'Queue 30 min timer', 'and offers to queue its timer');
  await tick(now + 180000 + 22 * 60000);
  await pause(400);
  assert.match(await evaluate('document.querySelector(".m-card").textContent'), /22 min ago/, 'The alert stays up through the meeting');
  await tick(now);
  await press('1');
  await pause(400);
  assert.equal(await evaluate('document.querySelector(".meeting-alert").classList.contains("on")'), false, 'A button dismisses the alert');
  assert.equal(await evaluate('CT.current'), 'clock', 'without also acting');
  await tick(now + 181000);
  await pause(400);
  assert.equal(await evaluate('document.querySelector(".meeting-alert").classList.contains("on")'), true, 'Dismissed early, it comes back as the meeting starts');
  await press('1');
  await tick(now);
  // Once the meeting has started, the back button starts its timer and brings it up.
  await evaluate("localStorage.removeItem('ct-dismissed-meetings')");
  await evaluate("CT.show('weather')");
  await message({ type: 'calendar', calendar: { status: 'ok', events: [{ start: now + 180000, end: now + 1980000, title: 'Standup', color: '#2d9cdb', allDay: false, calendarId: 'fixture' }] } });
  await pause(400);
  assert.equal(await evaluate('document.querySelector(".m-start").textContent'), 'Queue 30 min timer', 'Before the meeting starts, it offers to queue the timer');
  await tick(now + 181000);
  await pause(400);
  assert.equal(await evaluate('document.querySelector(".m-start").textContent'), 'Start 30 min timer', 'and to start it once it has');
  await evaluate('window.fixtureSent = []');
  await press('Escape');
  await pause(400);
  assert.equal(await evaluate('document.querySelector(".meeting-alert").classList.contains("on")'), false, 'The back button dismisses the alert');
  assert.equal(await evaluate('window.fixtureSent.some(m => m.type === "command")'), false, 'without favoriting the song');
  await pause(700);
  assert.equal(await evaluate('CT.current'), 'clock', 'and brings the meeting\'s timer up');
  assert.match(await rail(), /Standup29:5\d/, 'and is running');
  await press('Enter'); await press('Enter');
  await press('4');
  await pause(400);
  await tick(now);
  // Queued before it starts, the timer starts with the meeting, and the card doesn't come back.
  await evaluate("CT.show('weather')");
  await message({ type: 'calendar', calendar: { status: 'ok', events: [{ start: now + 180000, end: now + 1980000, title: 'Review', color: '#2d9cdb', allDay: false, calendarId: 'fixture' }] } });
  await pause(400);
  await press('Escape');
  await pause(400);
  assert.equal(await evaluate('document.querySelector(".meeting-alert.on .m-start").textContent'), 'Cancel timer', 'The back button queues it, and the card stays');
  await press('1');
  await tick(now + 181000);
  await pause(1100);
  assert.equal(await evaluate('CT.current'), 'clock', 'A queued timer comes up as the meeting starts');
  assert.match(await rail(), /Review29:5\d/, 'running');
  assert.equal(await evaluate('document.querySelector(".meeting-alert").classList.contains("on")'), false, 'in place of the card');
  await press('Enter'); await press('Enter');
  await press('4');
  await pause(400);
  await tick(now);
  await message({ type: 'settings', settings });
  // turn() counts rows, so this is Sleep's position in SettingsScreen.vue's list, not its name:
  // adding a row above it moves this number.
  await evaluate("CT.show('settings'); CT.screens.settings.turn(4); CT.screens.settings.press()");
  await pause(100);
  assert.equal(await evaluate('window.fixtureSent.some(m => m.type === "setting" && m.key === "screenSleep" && m.value === 30)'), true, 'Settings → Sleep steps With Mac to Mac idle 30 min');
  await capture('settings');
  await message({ type: 'settings', settings: { ...settings, theme: 'light' } });
  await evaluate("CT.show('clock')");
  await capture('clock-light');
  assert.equal(await evaluate('document.getElementById("app").classList.contains("light")'), true);
  await message({ type: 'volume', volume: { supported: true, volume: 0.4, muted: false } });
  await message({ type: 'volume', volume: { supported: true, volume: 0.6, muted: false } });
  await capture('volume');
  assert.equal(await evaluate('document.querySelector(".volume-hud .ui-progress").getAttribute("aria-valuenow")'), '60');
  await evaluate("window.dispatchEvent(new WheelEvent('wheel', {deltaX:53, cancelable:true}))");
  // The page batches knob turns for 40ms; on the device that can take a few hundred.
  const sentVolume = 'window.fixtureSent.some(m => m.type === "volume" && m.delta > 0)';
  for (let i = 0; i < 10 && !(await evaluate(sentVolume)); i++) await pause(100);
  assert.equal(await evaluate(sentVolume), true, 'Knob rotation sends volume');
  await message({ type: 'volume', volume: { supported: false, device: 'Digital output', volume: 0.6 } });
  await capture('volume-unsupported');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".volume-hud .ui-progress")).display'), 'none');
  await message({ type: 'screen', on: false });
  await capture('asleep');
  assert.equal(await evaluate('document.getElementById("app").classList.contains("asleep")'), true);
  await message({ type: 'screen', on: true });
  await message({ type: 'bye' });
  await capture('offline');
  assert.equal(await evaluate('document.getElementById("app").classList.contains("offline")'), true);
  assert.deepEqual(errors, [], 'No runtime exceptions');
  console.log('Device checks passed. Screenshots: ' + output);
} finally {
  await evaluate(devScreen ? 'sessionStorage.setItem("ct-dev-screen", ' + JSON.stringify(devScreen) + ')' : 'sessionStorage.removeItem("ct-dev-screen")');
  await cdp.send('Page.reload', { ignoreCache: true });
  cdp.close();
}
