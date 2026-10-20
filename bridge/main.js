#!/usr/bin/env node
// Car Thing bridge: macOS Now Playing, volume, weather, calendar and Bottlerocket/ChatGPT usage ⇄ the Car Thing's screen,
// knob and buttons. Also serves the Mac-side settings page.
//   npm start          run the bridge
//   npm run dev        …and redeploy the device UI whenever ui/ changes

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { APP_VOLUME, AppVolume } from './audio/app-volume.js';
import { Volume } from './audio/volume.js';
import { config, paths } from './config.js';
import { listCarThings, listDevices, onUsbBus, restartServer, trackDevices } from './device/adb.js';
import { DeviceLink } from './device/link.js';
import { log } from './log.js';
import { AppInfo, kindOf } from './nowplaying/apps.js';
import { ArtworkCache } from './nowplaying/artwork.js';
import { browserArtKey, largerBrowserArt } from './nowplaying/browser-art.js';
import { MediaRemoteSource } from './nowplaying/mediaremote.js';
import { MacAppearance } from './mac/appearance.js';
import { MacHelper } from './mac/helper.js';
import { MacPower } from './mac/power.js';
import { settings } from './settings.js';
import { startSettingsPage } from './settings-page/server.js';
import { Calendar } from './widgets/calendar.js';
import { Reminders } from './widgets/reminders.js';
import { BottlerocketUsage } from './widgets/bottlerocket-usage.js';
import { CodexUsage } from './widgets/codex-usage.js';
import { Weather } from './widgets/weather.js';

// Behind a network that re-signs TLS (a corporate proxy), the root the Mac trusts is in its
// keychain and not in the list Node ships with, so every request dies as UNABLE_TO_GET_ISSUER_
// CERT_LOCALLY. Trust both. Node before 22.15 has neither call and needs neither.
if (tls.getCACertificates && tls.setDefaultCACertificates) {
  try {
    tls.setDefaultCACertificates([...tls.getCACertificates('bundled'), ...tls.getCACertificates('system')]);
  } catch (err) {
    log.warn('[tls] keeping the bundled roots only', err.message);
  }
}

const source = new MediaRemoteSource(paths.bin);
const volume = new Volume(paths.bin);
const appVolume = new AppVolume();
const apps = new AppInfo(paths.bin);
const artwork = new ArtworkCache(path.join(paths.bin, 'artwork'), { blur: config.ambientBlurOnMac });
const helper = new MacHelper(paths.bin);
const weather = new Weather(helper, settings);
const calendar = new Calendar(helper, settings);
const reminders = new Reminders(helper, settings);
// Settings → Usage: only the providers it names are read (none: no Bottlerocket sign-in or Codex).
const usageSource = () => settings.get().usageSource;
const usage = new BottlerocketUsage({ enabled: () => usageSource() === 'bottlerocket' || usageSource() === 'both' });
const chatgptUsage = new CodexUsage({ enabled: () => usageSource() === 'chatgpt' || usageSource() === 'both' });
const appearance = new MacAppearance();
const power = new MacPower(paths.bin);

/** @type {DeviceLink|null} */
let link = null;
let connecting = false;

// ---- Now Playing ----------------------------------------------------------

// Latest snapshot with its artwork and app info resolved (both async, both cached).
let current = { np: source.snapshot, art: null, app: null };
let resolveSeq = 0;
let lastLogged = '';
const largerArt = new Map(); // source + video + artwork identity -> upgraded art (null: none found)

async function onNowPlaying(snapshot) {
  const seq = ++resolveSeq;
  const [art, app] = await Promise.all([
    snapshot.artwork ? artwork.get(snapshot.artwork) : null,
    snapshot.bundleId ? apps.get(snapshot.bundleId) : null,
  ]);
  if (seq !== resolveSeq) return; // superseded by a newer update
  const key = browserArtKey(snapshot);
  current = { np: snapshot, art: (key && largerArt.get(key)) || art, app };

  const summary = snapshot.active
    ? `${snapshot.playing ? '▶' : '❚❚'} ${snapshot.artist || '—'} · ${snapshot.title} [${app?.name || snapshot.bundleId}]`
    : 'nothing playing';
  if (summary !== lastLogged) log.info(`[now playing] ${(lastLogged = summary)}`);

  markTrack();
  if (link) pushNowPlaying(link);
  refreshKnobTarget(); // under 'auto', the playing app decides what the knob turns

  // Browser video art is often a small thumbnail. Look for a bigger one once per cover.
  if (!art || largerArt.has(key) || Math.min(art.width, art.height) >= 360) return;
  if (largerArt.size > 20) largerArt.delete(largerArt.keys().next().value);
  largerArt.set(key, null);
  const bigger = await largerBrowserArt(snapshot.bundleId, snapshot.title).catch(() => null);
  if (!bigger) return;
  const mime = bigger.buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
  const hi = await artwork.get({ key: `${key}-hi`, mime, base64: bigger.buf.toString('base64') });
  if (Math.min(hi.width, hi.height) < 360) return;
  largerArt.set(key, hi);
  log.info(`[artwork] ${hi.width}×${hi.height} from the playing tab`);
  if (browserArtKey(current.np) !== key) return; // moved on to another video meanwhile
  current = { ...current, art: hi };
  if (link) pushNowPlaying(link);
}

// Whether the playing Apple Music song is in the library and favorited, so Now Playing can show
// both and the back button's two toggles aren't a state you have to guess. Null for anything else,
// and until Music has answered for this track.
/** @type {{inLibrary: boolean, favorited: boolean}|null} */
let marks = null;
let marksTrack = ''; // the track `marks` describes ('' when there's nothing to mark)
let marksRefused = false; // Automation was denied: asking again on every track gets the same no

const markableTrack = (np) =>
  np.active && np.bundleId === 'com.apple.Music' ? `${np.title}\n${np.artist}\n${np.album}` : '';

/** Called for every snapshot; only a different song asks Music anything. */
function markTrack() {
  const track = markableTrack(current.np);
  if (track === marksTrack) return;
  marksTrack = track;
  marks = null; // the push that follows this call carries the new song with no marks yet
  if (track && !marksRefused) loadMarks(track);
}

async function loadMarks(track) {
  const r = await musicctl('status');
  if (track !== marksTrack) return; // the song moved on while Music was answering
  if (!r.ok) {
    if (r.code === MUSICCTL_REFUSED) marksRefused = true;
    return log.warn('[marks]', r.error);
  }
  marks = r.playing ? { inLibrary: r.inLibrary, favorited: r.favorited } : null;
  if (link) pushNowPlaying(link);
}

/** Keep the marks in step with a toggle we just made, instead of asking Music all over again. */
function setMark(field, value) {
  if (!marksTrack) return;
  marks = { inLibrary: false, favorited: false, ...marks, [field]: value };
  if (link) pushNowPlaying(link);
}

function nowPlayingMessage() {
  const { np, art, app } = current;
  if (!np.active) return { type: 'nowPlaying', np: { active: false } };

  let elapsed = null;
  if (np.elapsed != null) {
    elapsed = np.elapsed + ((Date.now() - np.elapsedAt) / 1000) * np.rate;
    if (np.duration) elapsed = Math.min(elapsed, np.duration);
    elapsed = Math.max(0, elapsed);
  }
  return {
    type: 'nowPlaying',
    np: {
      active: true,
      playing: np.playing,
      title: np.title,
      artist: np.artist,
      album: np.album,
      duration: np.duration,
      elapsed,
      rate: np.rate,
      kind: kindOf(np.bundleId),
      source: {
        bundleId: np.bundleId,
        name: app?.name || '',
        icon: config.unbadgedApps.includes(np.bundleId) ? null : app?.icon || null,
      },
      artworkKey: art?.key || null,
      // Whether this track *will* have marks, which the Mac knows at once — asking Music takes a
      // moment longer. The device holds the row's height from the start on the strength of it,
      // so the title is sized once instead of shrinking when the answer lands.
      markable: Boolean(markableTrack(np)) && !marksRefused,
      marks,
    },
  };
}

function pushNowPlaying(target) {
  const { art } = current;
  if (art && target.sentArtKey !== art.key) {
    target.send({ type: 'artwork', key: art.key, dataUrl: art.dataUrl, blurUrl: art.blurUrl, tint: art.tint, width: art.width, height: art.height });
    target.sentArtKey = art.key;
  }
  target.send(nowPlayingMessage());
}

const tickMessage = () => ({ type: 'tick', now: Date.now(), tzMinutes: -new Date().getTimezoneOffset() });

function pushAll(target) {
  target.sentArtKey = null; // page (re)loaded: it has no artwork cached
  target.send({
    type: 'config',
    config: {
      buttons: config.buttons,
      knobClicks: config.knobClicks,
      buttonClicks: config.buttonClicks,
      multiClickMs: config.multiClickMs,
      buttonHolds: config.buttonHolds,
      holdMs: config.holdMs,
      offlineSleepMs: config.deviceSleepSeconds * 1000,
      volumeStep: config.volumeStep,
      knobDirection: config.knobDirection,
      debug: Boolean(process.env.DEBUG), // page reports raw key/wheel events to the log
    },
  });
  target.send(tickMessage());
  target.send({ type: 'settings', settings: settings.get() });
  target.send({ type: 'appearance', dark: appearance.dark });
  const vol = volumeMessage();
  if (vol) target.send({ type: 'volume', volume: vol });
  pushNowPlaying(target);
  target.send({ type: 'weather', weather: weather.state });
  target.send({ type: 'calendar', calendar: calendar.state });
  target.send({ type: 'reminders', reminders: reminders.state });
  target.send({ type: 'usage', usage: usage.state });
  target.send({ type: 'chatgptUsage', usage: chatgptUsage.state });
  target.send({ type: 'screen', on: screenOn !== false }); // the page may have gone dark by itself
}

// ---- Screen sleep ---------------------------------------------------------

let systemAsleep = false;
let lastDeviceInput = 0;
let manualSleep = false; // held down the sleep button; any input clears it
let screenOn = null; // unknown until applied to the current device link

// The Car Thing's screen follows the Mac's display; a button/knob press wakes it for a while.
// While the Mac is locked it stays off for good: what's on it is the locked-away Mac's business.
function screenShouldBeOn() {
  if (manualSleep) return false;
  if (!settings.get().sleepWithMac) return true;
  if (systemAsleep || power.locked) return false;
  if (!power.displayAsleep) return true;
  return Date.now() - lastDeviceInput < config.screenWakeMs;
}

async function applyScreen() {
  const on = screenShouldBeOn();
  if (!link || on === screenOn) return;
  screenOn = on;
  log.info(`[screen] ${on ? 'on' : 'off'}`);
  await link.setScreen(on).catch((err) => {
    screenOn = null;
    log.warn('[screen]', err.message);
  });
  heartbeat(); // tell the device's watchdog what the screen is doing now, not in ten seconds
}

// The Mac says "still here" every few seconds. When it stops — the Mac was shut down, or the
// cable now only carries power — the device puts itself to sleep. See device/sleepd.sh.
//
// Only once a state has been applied to this link: the first beat after a reconnect is what the
// watchdog hands the screen back with, so it must say what we just set, not what the last link had.
function heartbeat() {
  if (screenOn === null) return;
  link?.heartbeat(screenOn).catch((err) => log.debug('[heartbeat]', err.message));
}

async function macStatus() {
  const s = await helper.status().catch(() => ({}));
  // The lists are for the settings page's checkboxes; each is empty until access is granted.
  const [cals, lists] = await Promise.all([
    helper.calendars().catch(() => ({})),
    helper.reminderLists().catch(() => ({})),
  ]);
  return {
    location: { status: s.location || 'unknown', name: weather.auto?.name || null },
    calendar: { status: s.calendar || 'unknown', list: cals.ok ? cals.calendars : [] },
    reminders: { status: s.reminders || 'unknown', list: lists.ok ? lists.reminderLists : [] },
    // Spend and whether a token is set — never the token itself.
    bottlerocket: await bottlerocketStatus(usage),
  };
}

async function bottlerocketStatus(widget) {
  const state = widget.state;
  return {
    status: state.status || 'loading',
    hasToken: await widget.hasToken().catch(() => false),
    detail: state.detail || '',
    spent: Number.isFinite(state.spent) ? state.spent : null,
    limit: Number.isFinite(state.limit) ? state.limit : null,
    percent: Number.isFinite(state.percent) ? state.percent : null,
  };
}

function openSettingsPage(section) {
  const hash = /^[a-z]+$/.test(section || '') ? `#${section}` : '';
  execFile('/usr/bin/open', [`http://127.0.0.1:${config.settingsPort}/${hash}`]);
}

// ---- Input from the device ------------------------------------------------

/** Apple Music actions via native/bin/musicctl (macOS asks once to let "musicctl" control Music). */
function musicctl(command, argument) {
  const args = argument ? [command, argument] : [command];
  return new Promise((resolve) =>
    // Long timeout: the first run waits on the Automation permission prompt.
    execFile(path.join(paths.bin, 'musicctl'), args, { timeout: 60000 }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ ok: false, error: err?.message || 'musicctl failed' });
      }
    }),
  );
}

async function runCommand(action) {
  log.info(`[input] ${action}`);
  if (action === 'library') return toggleLibrary();
  if (action === 'favorite') return toggleFavorite();
  try {
    if (!current.np.active && (action === 'playpause' || action === 'play')) {
      const r = await musicctl('play'); // nothing playing: start Apple Music
      if (!r.ok) log.warn('[input] starting Music failed:', r.error);
    } else {
      await source.command(action);
    }
  } catch (err) {
    log.warn(`[input] ${action} failed:`, err.message);
  }
}

/** Both of the back button's toggles want an Apple Music song. Returns it, or null having said
 *  why — `needs` reads out when something else is playing. Paused counts: the marks are on screen
 *  either way, and a song you've stopped to think about is one you might want to keep. */
function playingAppleMusic(needs) {
  const { np } = current;
  if (np.active && np.bundleId === 'com.apple.Music') return np;
  link?.send({ type: 'toast', text: np.active ? needs : 'Nothing playing' });
  return null;
}

const MUSICCTL_REFUSED = -1743; // the user said no to "musicctl wants to control Music"
const MUSICCTL_KEEP = 1001; // musicctl declined to remove a song it didn't recognise as streamed

const musicctlProblem = (r, fallback) =>
  r.code === MUSICCTL_REFUSED ? 'Allow musicctl to control Music' : r.code === MUSICCTL_KEEP ? r.error : fallback;

async function toggleLibrary() {
  const np = playingAppleMusic('Your library works with Apple Music');
  if (!np) return;
  // Say which way when the marks say where the song stands. A track just duplicated into the
  // library takes a moment to appear there, so a direction worked out by reading would miss a
  // second press that soon — reporting another add, and making a duplicate to go with it.
  const r = await musicctl('library', marks ? (marks.inLibrary ? 'off' : 'on') : null);
  if (r.ok) {
    log.info(`[library] ${np.title}: ${r.inLibrary ? 'added' : 'removed'}`);
    setMark('inLibrary', r.inLibrary);
    link?.send({ type: 'library', inLibrary: r.inLibrary });
  } else {
    log.warn('[library]', r.error);
    link?.send({ type: 'toast', text: musicctlProblem(r, 'Couldn’t change your library') });
  }
}

async function toggleFavorite() {
  const np = playingAppleMusic('Favorites work with Apple Music');
  if (!np) return;
  // Say which way when the marks say where the song stands: Music keeps answering with the old
  // value for a second or so after a write, so a direction worked out by reading would miss a
  // second press that soon and favorite the song twice.
  const r = await musicctl('favorite', marks ? (marks.favorited ? 'off' : 'on') : null);
  if (r.ok) {
    log.info(`[favorite] ${np.title}: ${r.favorited ? 'added' : 'removed'}`);
    setMark('favorited', r.favorited);
    link?.send({ type: 'favorite', favorited: r.favorited });
  } else {
    log.warn('[favorite]', r.error);
    link?.send({ type: 'toast', text: musicctlProblem(r, 'Couldn’t favorite this song') });
  }
}

const FINE_KEY_STEP = 1 / 64; // one Option+Shift volume-key press
const KEY_STEP = 1 / 16; // one plain volume-key press — and, as it happens, one knob detent
const KEY_GATHER_MS = 70; // a burst of turning is gathered this long before it goes out
const MAX_PRESSES = 8; // further than this in one go and tapping it out is slower than setting it

// Pressing the volume keys is what makes macOS show its own volume indicator, but every press is
// a separate event the Mac applies in turn — so the output follows the *path* the knob took
// rather than where it ended up. Turning up and back down again was walked out in full, audibly,
// and the Mac arrived as much as a second behind the knob. Two things keep it close:
//
//   - whole detents instead of 64ths. A knob click is 1/16, which is exactly one plain press;
//     sending it as four Option+Shift presses was four times the events for the same distance.
//   - gathering a burst before pressing it out, so a spin that doubles back cancels itself
//     instead of being played out. The first turn of a burst still goes straight out, so a single
//     click is as immediate as it ever was.
//
// A gathered burst big enough that tapping it out would itself be the delay is set directly
// instead. That skips macOS's indicator, which is the right trade: the knob has its own.
let keyBacklog = 0;
let keyTimer = null;
let lastPressAt = 0;

function changeVolume(delta) {
  if (!Number.isFinite(delta) || delta === 0) return;
  const app = knobApp();
  if (app) return changeAppVolume(app, delta);
  askForKeyAccess();
  if (!(config.macVolumeIndicator && volume.state?.keys)) return volume.delta(delta);
  keyBacklog += delta;
  if (keyTimer) return;
  const since = Date.now() - lastPressAt;
  if (since >= KEY_GATHER_MS) pressBacklog();
  else keyTimer = setTimeout(pressBacklog, KEY_GATHER_MS - since);
}

function pressBacklog() {
  keyTimer = null;
  lastPressAt = Date.now();
  const want = keyBacklog;
  keyBacklog = 0;
  if (!want) return;
  if (Math.round(Math.abs(want) / KEY_STEP) > MAX_PRESSES) return volume.delta(want);
  const up = want > 0;
  const size = Math.abs(want);
  const whole = Math.floor(size / KEY_STEP + 1e-9);
  for (let i = 0; i < whole; i++) volume.pressKey(up, { fine: false });
  const fine = Math.round((size - whole * KEY_STEP) / FINE_KEY_STEP);
  for (let i = 0; i < fine; i++) volume.pressKey(up);
  // Presses only come in 64ths. Keep whatever wouldn't divide into one: the gathered bursts of a
  // spin that doubles back rarely land on a 64th, and dropping each remainder cost a whole detent
  // over the length of one.
  keyBacklog += want - (up ? 1 : -1) * (whole * KEY_STEP + fine * FINE_KEY_STEP);
}

// ---- Knob volume: the Mac's output or an app's own ----------------------------------------
// settings.knobVolume picks what the knob turns: 'system' (the Mac's output), 'spotify' or
// 'music' (that app's own volume slider, over AppleScript), or 'auto' — the output, unless it
// has no volume of its own (an HDMI monitor), then the playing app's if it's Spotify or Music.
// An app's volume is first read on a knob turn, so macOS only asks for the Automation
// permission ("node wants to control Spotify") when someone actually uses it.

const KNOB_APPS = { spotify: 'com.spotify.client', music: 'com.apple.Music' };

let appVol = null; // {bundleId, level: 0–100, fractional} once the knob has read that app's volume
let appVolTouched = 0; // last knob turn: a background read mustn't undo what the knob just did
let appVolReading = false;
let appVolError = ''; // last failure logged, so the same one isn't logged on every turn
let appVolToastAt = 0;
const APP_VOL_QUIET_MS = 2000;

/** The bundle id whose volume the knob turns, or null for the Mac's output volume. */
function knobApp() {
  const mode = settings.get().knobVolume;
  if (KNOB_APPS[mode]) return KNOB_APPS[mode];
  if (mode !== 'auto' || !volume.state || volume.state.supported) return null;
  const { np } = current;
  return np.active && AppVolume.supports(np.bundleId) ? np.bundleId : null;
}

/** What the device shows: {volume, muted, supported, device, app?: the app the knob turns}. */
function volumeMessage() {
  const v = volume.state;
  const app = knobApp();
  if (!app) {
    // Under 'auto' on an output with no volume (an HDMI monitor), playing Spotify or Music would
    // give the knob something to turn, so say that rather than blaming the output.
    if (v && !v.supported && settings.get().knobVolume === 'auto' && !current.np.active) return { ...v, note: 'No music playing' };
    return v;
  }
  const base = { device: v?.device || '', keys: v?.keys };
  if (appVol?.bundleId === app) return { ...base, volume: appVol.level / 100, muted: false, supported: true, app: APP_VOLUME[app].name, appId: app };
  // Not read yet, or the app isn't running: the page sends the turn anyway and the read answers it.
  return { ...base, volume: null, muted: false, supported: false, app: APP_VOLUME[app].name, appId: app };
}

let lastVolumeSent = '';
function pushVolume({ force = false } = {}) {
  const v = volumeMessage();
  const json = JSON.stringify(v);
  if (!v || (!force && json === lastVolumeSent)) return;
  lastVolumeSent = json;
  link?.send({ type: 'volume', volume: v });
}

/** Forgets the app's volume when the knob no longer turns that app (setting, source or output changed). */
function refreshKnobTarget() {
  if (appVol && knobApp() !== appVol.bundleId) appVol = null;
  pushVolume();
}

function appVolFailed(r, bundleId, { toast = false } = {}) {
  appVol = null;
  pushVolume();
  const { name } = APP_VOLUME[bundleId];
  if (!r.notRunning) {
    const text = `${r.code || ''} ${r.error || ''}`;
    if (text !== appVolError) log.warn(`[volume] ${name}'s volume:`, r.error);
    appVolError = text;
  }
  if (!toast || Date.now() - appVolToastAt < 2500) return;
  appVolToastAt = Date.now();
  // -1743: the user said no to "node wants to control …" (System Settings → Privacy & Security → Automation).
  const text = r.notRunning ? `${name} isn’t running`
    : r.code === -1743 ? `Allow control of ${name} in Automation`
    : r.timedOut ? `Allow control of ${name} on your Mac`
    : `Couldn’t change ${name}’s volume`;
  link?.send({ type: 'toast', text });
}

async function readAppVolume(bundleId) {
  appVolReading = true;
  try {
    return await appVolume.read(bundleId);
  } finally {
    appVolReading = false;
  }
}

async function changeAppVolume(bundleId, delta) {
  appVolTouched = Date.now();
  if (appVol?.bundleId !== bundleId) {
    if (appVolReading) return; // the first turn is still reading it (or waiting on the permission prompt)
    const r = await readAppVolume(bundleId);
    if (!r.ok) return appVolFailed(r, bundleId, { toast: true });
    if (knobApp() !== bundleId) return;
    appVol = { bundleId, level: r.volume };
    appVolError = '';
    log.info(`[volume] the knob turns ${APP_VOLUME[bundleId].name}'s volume (${r.volume})`);
  }
  appVol.level = Math.min(100, Math.max(0, appVol.level + delta * 100));
  const r = await appVolume.set(bundleId, appVol.level);
  appVolTouched = Date.now();
  if (r && !r.ok) return appVolFailed(r, bundleId, { toast: true });
  pushVolume();
}

/** Every few seconds while the knob turns an app: follow its own slider, and notice it quitting. */
async function syncAppVolume() {
  refreshKnobTarget();
  if (!appVol || appVolReading || appVolume.running || Date.now() - appVolTouched < APP_VOL_QUIET_MS) return;
  const { bundleId } = appVol;
  const r = await readAppVolume(bundleId);
  if (Date.now() - appVolTouched < APP_VOL_QUIET_MS || appVolume.running || appVol?.bundleId !== bundleId) return;
  if (!r.ok) return appVolFailed(r, bundleId);
  // Keep the knob's fractional level unless the app really moved.
  if (Math.round(appVol.level) !== r.volume) appVol.level = r.volume;
  pushVolume();
}

// Asked on a knob turn rather than at startup: macOS's prompt only stays up briefly, so it
// should appear while someone is turning the knob and looking, with the device saying why.
// Its button opens System Settings, where MacThingVolume is already listed, switched off.
// A helper process keeps the first answer it got, so after asking, a fresh one is started every
// few seconds until the permission shows up — allowing it then needs no restart.
let askedForKeyAccess = false;
const KEY_RECHECK_MS = 3000;
const KEY_RECHECK_FOR_MS = 3 * 60 * 1000;
function askForKeyAccess() {
  if (!config.macVolumeIndicator || !volume.state || volume.state.keys || askedForKeyAccess) return;
  askedForKeyAccess = true;
  log.warn(
    '[volume] to show the macOS volume indicator, allow "MacThingVolume" in System Settings → ' +
      'Privacy & Security → Accessibility. Until then the knob sets the volume silently.',
  );
  volume.requestKeyAccess();
  link?.send({ type: 'toast', text: 'Allow MacThingVolume on your Mac' });
  const until = Date.now() + KEY_RECHECK_FOR_MS;
  const timer = setInterval(() => {
    if (volume.state?.keys || Date.now() > until) {
      clearInterval(timer);
      if (volume.state?.keys) log.info('[volume] MacThingVolume allowed: the knob shows the macOS volume indicator');
      return;
    }
    volume.recheck();
  }, KEY_RECHECK_MS);
}

function onDeviceMessage(msg) {
  if (msg.type === 'command' || msg.type === 'volume' || msg.type === 'wake') {
    lastDeviceInput = Date.now();
    manualSleep = false;
    applyScreen();
  }
  switch (msg.type) {
    case 'sleep':
      log.info('[screen] sleep requested from the device');
      manualSleep = true;
      return applyScreen();
    case 'command':
      return runCommand(msg.action);
    case 'volume':
      return changeVolume(Number(msg.delta));
    case 'setting':
      return settings.update({ [msg.key]: msg.value });
    case 'openSettingsPage':
      return openSettingsPage(msg.section);
    case 'retryWeather':
      return retryWeather(msg.quiet);
    case 'refreshUsage':
      return Promise.allSettled([chatgptUsage.ask(), usage.ask()]).then(() => {
        if (msg.ack) link?.send({ type: 'usageRefreshed' });
      });
    case 'log':
      return log.info('[device]', msg.message);
  }
}

/** The weather button on an unavailable forecast: try again, or say how long until it can. */
async function retryWeather(quiet) {
  const r = await weather.retry();
  if (typeof r === 'number' && !quiet) link?.send({ type: 'toast', text: `Try again in ${r}s` });
}

// ---- Device lifecycle -----------------------------------------------------

// After the Mac sleeps, adb's server can keep an empty device list while the Car Thing is sitting
// on the USB bus perfectly happy — `ioreg -p IOUSB` shows it, `adb devices` doesn't, and no
// track-devices event ever arrives to say otherwise. Restarting the server fixes it at once, so
// treat a device-shaped silence as a stale server rather than an absent device.
let lastSeen = Date.now();
let lastServerRestart = 0;

async function refreshDevices() {
  let all;
  try {
    all = await listDevices();
  } catch (err) {
    return log.warn('[adb]', err.message);
  }
  let devices = all.filter((d) => d.carThing).map(({ serial }) => ({ serial }));

  if (!devices.length && !connecting && !all.length && Date.now() - lastServerRestart > config.adbRestartMs) {
    // Only when the server lists nothing at all AND the hardware is really on the bus. Anything
    // else on the list means the list isn't stale, and kill-server would drop someone else's
    // session; nothing on the bus means the device is unplugged and there's nothing to fix.
    if (await onUsbBus()) {
      lastServerRestart = Date.now();
      log.info('[adb] the Car Thing is on the USB bus but adb cannot see it — restarting the adb server');
      await restartServer();
      devices = await listCarThings().catch(() => []);
      if (devices.length) log.info('[adb] the server had gone stale; the device was there all along');
    }
  }
  if (devices.length) lastSeen = Date.now();

  if (link && !devices.some((d) => d.serial === link.serial)) link.close();
  if (!link && !connecting && devices.length) await connect(devices[0].serial);
}

async function connect(serial) {
  connecting = true;
  const l = new DeviceLink(serial);
  l.on('ready', () => pushAll(l));
  l.on('message', onDeviceMessage);
  screenOn = null; // whatever it was belonged to the last link
  l.on('close', () => {
    if (link !== l) return;
    link = null;
    log.info('[device] disconnected');
    setTimeout(refreshDevices, 1500);
  });
  link = l;
  try {
    log.info(`[device] connecting to ${serial}…`);
    await l.connect();
    log.info('[device] connected');
    screenOn = null;
    manualSleep = false;
    await applyScreen();
    heartbeat();
  } catch (err) {
    log.warn('[device] connect failed:', err.message);
    if (link === l) link = null;
    l.close();
    setTimeout(refreshDevices, 3000);
  } finally {
    connecting = false;
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---- Start ----------------------------------------------------------------

log.info('Car Thing bridge starting');
source.on('change', (s) => onNowPlaying(s).catch((err) => log.warn('[now playing]', err.message)));
volume.on('change', (v) => {
  if (appVol && knobApp() !== appVol.bundleId) appVol = null;
  pushVolume({ force: true });
});
settings.on('change', (values, changed) => {
  link?.send({ type: 'settings', settings: values });
  if (changed.includes('knobVolume')) refreshKnobTarget();
  if (changed.includes('sleepWithMac')) applyScreen();
});
settings.on('change', (_, changed) => {
  if (!changed.includes('usageSource')) return;
  usage.refresh();
  chatgptUsage.refresh();
});
weather.on('change', (state) => link?.send({ type: 'weather', weather: state }));
calendar.on('change', (state) => link?.send({ type: 'calendar', calendar: state }));
reminders.on('change', (state) => link?.send({ type: 'reminders', reminders: state }));
usage.on('change', (state) => link?.send({ type: 'usage', usage: state }));
chatgptUsage.on('change', (state) => link?.send({ type: 'chatgptUsage', usage: state }));
appearance.on('change', (dark) => link?.send({ type: 'appearance', dark }));
power.on('display', () => applyScreen());
power.on('lock', (locked) => {
  log.info(`[screen] Mac ${locked ? 'locked' : 'unlocked'}`);
  applyScreen();
});
power.on('willSleep', async () => {
  systemAsleep = true;
  await Promise.race([applyScreen(), new Promise((r) => setTimeout(r, 2500))]);
  power.ack(); // let the Mac go to sleep
});
power.on('didWake', () => {
  systemAsleep = false;
  applyScreen();
  // Waking is exactly when adb's list goes stale, so look now and again once USB has settled,
  // instead of waiting out the timer that exists for ordinary unplugs.
  refreshDevices();
  setTimeout(refreshDevices, 8000);
});
source.start();
volume.start();
helper.start();
weather.start();
calendar.start();
reminders.start();
usage.start();
chatgptUsage.start();
appearance.start();
power.start();
startSettingsPage({
  port: config.settingsPort,
  settings,
  status: macStatus,
  setBottlerocketToken: (token) => usage.setToken(token),
});

trackDevices(debounce(refreshDevices, 400));
setInterval(refreshDevices, 30 * 1000); // a stale adb server sends no events; look anyway
refreshDevices();

setInterval(() => link?.send(tickMessage()), 2000);
setInterval(() => applyScreen(), 5000); // lets the post-input wake window expire
setInterval(() => syncAppVolume(), 10 * 1000); // follows the app's own volume slider while the knob turns it
setInterval(heartbeat, config.heartbeatMs);
setInterval(() => link?.send(nowPlayingMessage()), 15000); // re-anchor the device's progress clock

if (process.argv.includes('--watch')) {
  log.info(`[dev] watching Vue source in ${paths.uiSource}`);
  let building = false;
  let pending = false;
  const rebuild = async () => {
    if (building) { pending = true; return; }
    building = true;
    try {
      do {
        pending = false;
        await new Promise((resolve, reject) => {
          execFile(process.execPath, [path.join(paths.root, 'node_modules/vite/bin/vite.js'), 'build'],
            { cwd: paths.root }, (err, stdout, stderr) => err ? reject(new Error(stderr || stdout || err.message)) : resolve());
        });
      } while (pending);
      await link?.redeploy();
    } catch (err) { log.warn('[dev] build/deploy failed:', err.message); }
    finally {
      building = false;
      if (pending) { pending = false; rebuild(); }
    }
  };
  const redeploy = debounce(rebuild, 300);
  fs.watch(paths.uiSource, { recursive: true }, redeploy);
  fs.watch(path.join(paths.root, 'vite.config.js'), redeploy);
}

async function shutdown() {
  log.info('shutting down');
  // Don't leave the Car Thing dark with nothing to wake it — unless its own watchdog is there,
  // which wakes the screen on any button or knob press and would only turn it off again anyway.
  if (link && screenOn === false && !link.sleepd) {
    await Promise.race([link.setScreen(true).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  }
  link?.send({ type: 'bye' });
  source.stop();
  volume.stop();
  helper.stop();
  power.stop();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
