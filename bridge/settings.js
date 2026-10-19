import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

// User-changeable settings (from the device's settings screen or the Mac settings page),
// persisted outside the repo. Developer-level options live in config.js instead.
const FILE = path.join(os.homedir(), 'Library', 'Application Support', 'carthing-now-playing', 'settings.json');

export const DEFAULTS = {
  theme: 'dark', // 'dark' | 'light' | 'auto' (follow the Mac's appearance)
  units: 'F', // weather temperature: 'F' | 'C'
  clock24h: false,
  clockFace: 'analog', // 'analog' | 'numbers' | 'digital'
  artBackground: false, // blurred album art behind Now Playing and the widgets
  location: { mode: 'auto' }, // or { mode: 'manual', name, lat, lon }
  calendars: null, // null = every calendar in the Mac's Calendar app; else an array of calendar ids
  calendarDays: 2, // days of events on the Calendar screen: today plus the next (n − 1)
  meetingAlert: 0, // when a timed event's alert covers the screen: 0 = off, 'event' = at the event's own alert, else minutes before
  usageSource: 'claude', // the Clock screen's usage views: 'claude' (Claude Code) | 'chatgpt' (Codex) | 'both' | 'none'
  // What the knob turns: 'auto' = the Mac's output, or when it has no volume of its own (an HDMI
  // monitor) the playing app's if it's Spotify or Music | 'system' | 'spotify' | 'music'
  knobVolume: 'auto',
  idleMinutes: 0, // once nothing has played this long on Now Playing, show idleScreen (0 = never)
  idleScreen: 'clock', // 'clock' | 'calendar' | 'weather'
  sleepWithMac: config.sleepWithMac, // screen off while the Mac's display sleeps or the Mac is locked
};

const VALID = {
  theme: (v) => ['dark', 'light', 'auto'].includes(v),
  units: (v) => v === 'F' || v === 'C',
  clock24h: (v) => typeof v === 'boolean',
  clockFace: (v) => ['analog', 'numbers', 'digital'].includes(v),
  artBackground: (v) => typeof v === 'boolean',
  location: (v) =>
    v?.mode === 'auto' ||
    (v?.mode === 'manual' && typeof v.name === 'string' && Number.isFinite(v.lat) && Number.isFinite(v.lon)),
  calendars: (v) => v === null || (Array.isArray(v) && v.every((id) => typeof id === 'string')),
  calendarDays: (v) => Number.isInteger(v) && v >= 1 && v <= 7,
  meetingAlert: (v) => [0, 'event', 1, 5, 10].includes(v),
  usageSource: (v) => ['claude', 'chatgpt', 'both', 'none'].includes(v),
  knobVolume: (v) => ['auto', 'system', 'spotify', 'music'].includes(v),
  idleMinutes: (v) => [0, 1, 2, 5, 10].includes(v),
  idleScreen: (v) => ['clock', 'calendar', 'weather'].includes(v),
  sleepWithMac: (v) => typeof v === 'boolean',
};

class Settings extends EventEmitter {
  constructor() {
    super();
    this.values = { ...DEFAULTS, ...this.#load() };
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return Object.fromEntries(Object.entries(raw).filter(([k, v]) => VALID[k]?.(v)));
    } catch {
      return {};
    }
  }

  get() {
    return this.values;
  }

  /** Applies the valid, changed keys of `patch`; emits 'change' (values, changedKeys). */
  update(patch) {
    const changed = Object.entries(patch ?? {}).filter(
      ([k, v]) => VALID[k]?.(v) && JSON.stringify(v) !== JSON.stringify(this.values[k]),
    );
    if (!changed.length) return false;
    this.values = { ...this.values, ...Object.fromEntries(changed) };
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(this.values, null, 2));
      fs.renameSync(`${FILE}.tmp`, FILE);
    } catch (err) {
      log.warn('[settings] could not save:', err.message);
    }
    this.emit('change', this.values, changed.map(([k]) => k));
    return true;
  }
}

export const settings = new Settings();
