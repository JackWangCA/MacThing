import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';

const SESSIONS = path.join(os.homedir(), '.codex', 'sessions');
const REFRESH_MS = 60 * 1000;
// How far back to look for the last limits Codex saw. Anything over a week old has reset (both
// rings at 0%), but finding it still tells "fresh" apart from "Codex isn't used on this Mac".
const DAYS_BACK = 31;
const SESSION_MINUTES = 300;
const WEEK_MINUTES = 7 * 24 * 60;

/**
 * ChatGPT plan usage for the Clock screen's usage view, the ChatGPT side of Settings → Usage: the
 * five-hour and weekly limits Codex runs under on a ChatGPT plan. Codex (the app or the command
 * line) writes them into its session logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) with
 * every reply it gets, so this reads the newest of those — no sign-in and no network. They only
 * change while Codex is in use; a window whose reset has passed since then is back at 0%.
 *
 * `state` is one of:
 *   { status: 'ok', session: {percent, resetsAt}, week: {percent, resetsAt}, updatedAt }
 *     (the same shape as ClaudeUsage's; updatedAt is when Codex last saw them)
 *   { status: 'none' }      no Codex limits in the last month's logs
 *   { status: 'loading' }
 */
export class CodexUsage extends EventEmitter {
  /** @param {{enabled?: () => boolean}} [opts] enabled: whether it's wanted now (Settings → Usage); while not, nothing is read */
  constructor({ enabled = () => true } = {}) {
    super();
    this.enabled = enabled;
    this.state = { status: 'loading' };
    this.latest = null; // the newest log file read, and its mtime, so an unchanged one isn't re-read
    this.snapshot = null;
    this.inflight = null;
  }

  start() {
    this.refresh();
    setInterval(() => this.refresh(), REFRESH_MS);
  }

  refresh() {
    if (!this.enabled()) return Promise.resolve();
    this.inflight ??= this.#refresh()
      .catch((err) => log.warn('[chatgpt usage]', err.message))
      .finally(() => (this.inflight = null));
    return this.inflight;
  }

  async #refresh() {
    const files = await recentLogs();
    const newest = files[0];
    if (!newest || newest.path !== this.latest?.path || newest.mtime !== this.latest?.mtime) {
      this.latest = newest || null;
      this.snapshot = null;
      // The newest log may be a session that never got as far as a reply, so look back further.
      for (const file of files) {
        this.snapshot = await lastLimits(file);
        if (this.snapshot) break;
      }
    }
    this.#set(this.snapshot ? toState(this.snapshot, Date.now()) : { status: 'none' });
  }

  #set(state) {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.emit('change', state);
  }
}

/** The last DAYS_BACK days' Codex logs, newest first: [{path, mtime}]. */
async function recentLogs() {
  const files = [];
  for (let back = 0; back < DAYS_BACK; back++) {
    const d = new Date(Date.now() - back * 86400000);
    const dir = path.join(SESSIONS, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    const names = await fs.readdir(dir).catch(() => []);
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat) files.push({ path: file, mtime: stat.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

/** The last rate limits in a log that has both windows: {primary, secondary, at}. */
async function lastLimits({ path: file, mtime }) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const limits = findLimits(entry);
    if (limits?.primary && limits?.secondary) {
      return { primary: limits.primary, secondary: limits.secondary, at: Date.parse(entry.timestamp) || mtime };
    }
  }
  return null;
}

function findLimits(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.rate_limits) return value.rate_limits;
  for (const v of Object.values(value)) {
    const found = findLimits(v);
    if (found) return found;
  }
  return null;
}

// Codex calls the five-hour window primary and the week secondary; window_minutes says which is
// which in case that ever swaps.
function toState({ primary, secondary, at }, now) {
  const windows = [primary, secondary];
  const pick = (minutes) => windows.find((w) => w.window_minutes === minutes);
  return {
    status: 'ok',
    session: windowOf(pick(SESSION_MINUTES) || primary, now),
    week: windowOf(pick(WEEK_MINUTES) || secondary, now),
    updatedAt: at,
  };
}

function windowOf(w, now) {
  const resetsAt = Number(w.resets_at) * 1000;
  // Reset since Codex last ran: the window is fresh, and starts again with the next message.
  if (!Number.isFinite(resetsAt) || resetsAt <= now) return { percent: 0, resetsAt: null };
  return { percent: Math.max(0, Math.min(100, Math.round(Number(w.used_percent) || 0))), resetsAt };
}
