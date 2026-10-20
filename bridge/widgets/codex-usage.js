import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';

const REFRESH_MS = 5 * 60 * 1000;
// Opening the usage view asks for fresh numbers, but no more often than this.
const ASK_MIN_MS = 60 * 1000;
const TIMEOUT_MS = 20 * 1000;
const SESSION_MINUTES = 300;
const WEEK_MINUTES = 7 * 24 * 60;
// Where Codex lives besides PATH: a LaunchAgent's PATH leaves out most of these, and the ChatGPT
// app (which Codex Desktop is part of) bundles its own copy.
const CANDIDATES = [
  path.join(os.homedir(), '.local', 'bin', 'codex'),
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
];

/**
 * ChatGPT plan usage for the Clock screen's usage view, the ChatGPT side of Settings → Usage: the
 * five-hour and weekly limits Codex runs under on a ChatGPT plan, live from OpenAI. It asks the
 * installed Codex for them (`codex app-server`, request account/rateLimits/read), the way Codex's
 * own /status does, so Codex's sign-in stays Codex's: it reads and renews its own token, and
 * nothing here ever touches ~/.codex/auth.json.
 *
 * `state` is one of:
 *   { status: 'ok', session: {percent, resetsAt}, week: {percent, resetsAt}, updatedAt }
 *     (the same shape as ClaudeUsage's; resetsAt is null for a window that hasn't started)
 *   { status: 'signedOut' }   Codex isn't signed in to a ChatGPT account
 *   { status: 'none' }        Codex isn't installed on this Mac
 *   { status: 'error' }       and no earlier numbers to fall back on
 *   { status: 'loading' }
 */
export class CodexUsage extends EventEmitter {
  /** @param {{enabled?: () => boolean}} [opts] enabled: whether it's wanted now (Settings → Usage); while not, Codex isn't asked */
  constructor({ enabled = () => true } = {}) {
    super();
    this.enabled = enabled;
    this.state = { status: 'loading' };
    this.inflight = null;
    this.lastTry = 0;
  }

  start() {
    this.refresh();
    setInterval(() => this.refresh(), REFRESH_MS);
  }

  /** The device opened the usage view: fresh numbers, unless they were just fetched. */
  ask() {
    if (Date.now() - this.lastTry < ASK_MIN_MS) return this.inflight;
    return this.refresh();
  }

  refresh() {
    if (!this.enabled()) return Promise.resolve();
    this.inflight ??= this.#refresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  async #refresh() {
    this.lastTry = Date.now();
    const codex = await findCodex();
    if (!codex) return this.#set({ status: 'none' });
    try {
      const limits = await readRateLimits(codex);
      this.#set(toState(limits, Date.now()));
    } catch (err) {
      if (/authentication required|not logged in|sign in/i.test(err.message)) return this.#set({ status: 'signedOut' });
      log.warn('[chatgpt usage]', err.message);
      if (this.state.status !== 'ok') this.#set({ status: 'error' });
    }
  }

  #set(state) {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.emit('change', state);
  }
}

async function findCodex() {
  const onPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'codex'));
  for (const file of new Set([...onPath, ...CANDIDATES])) {
    if (await fs.access(file, constants.X_OK).then(() => true, () => false)) return file;
  }
  return null;
}

/** One app-server session: initialize, read the limits, quit. Resolves with the rateLimits snapshot. */
function readRateLimits(codex) {
  return new Promise((resolve, reject) => {
    const child = spawn(codex, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    const finish = (err, value) => {
      clearTimeout(timer);
      child.kill();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex took too long to answer')), TIMEOUT_MS);
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', (err) => finish(err));
    child.stdin.on('error', () => {});
    child.on('exit', () => finish(new Error('Codex quit before answering')));
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 'init') {
          if (message.error) return finish(new Error(message.error.message));
          send({ method: 'initialized' });
          send({ id: 'limits', method: 'account/rateLimits/read' });
        } else if (message.id === 'limits') {
          if (message.error) return finish(new Error(message.error.message));
          const limits = message.result?.rateLimitsByLimitId?.codex || message.result?.rateLimits;
          return limits?.primary && limits?.secondary ? finish(null, limits) : finish(new Error('no limits in the answer'));
        }
      }
    });
    send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'macthing', title: 'MacThing', version: '1' } } });
  });
}

// Codex calls the five-hour window primary and the week secondary; windowDurationMins says which
// is which in case that ever swaps.
function toState({ primary, secondary }, now) {
  const windows = [primary, secondary];
  const pick = (minutes) => windows.find((w) => w.windowDurationMins === minutes);
  return {
    status: 'ok',
    session: windowOf(pick(SESSION_MINUTES) || primary, now),
    week: windowOf(pick(WEEK_MINUTES) || secondary, now),
    updatedAt: now,
  };
}

function windowOf(w, now) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(w.usedPercent) || 0)));
  const resetsAt = Number(w.resetsAt) * 1000;
  // A window that hasn't started yet is reported as resetting a whole window from now (and that
  // moves on with every ask), so it's shown as not started, like Claude's.
  const unstarted = !percent && resetsAt - now > (Number(w.windowDurationMins) - 2) * 60000;
  return { percent, resetsAt: Number.isFinite(resetsAt) && resetsAt > now && !unstarted ? resetsAt : null };
}
