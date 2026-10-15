import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';

const REFRESH_MS = 5 * 60 * 1000;
// Opening the usage view asks for fresh numbers, but no more often than this.
const ASK_MIN_MS = 60 * 1000;
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

/**
 * Claude plan usage for the Clock screen's usage view: the current five-hour session and the
 * week, the same numbers Claude Code's /usage shows. It reads Claude Code's own sign-in (the
 * "Claude Code-credentials" Keychain item, or ~/.claude/.credentials.json) and only ever uses
 * the access token, never the refresh token — refreshing would rotate it out from under Claude
 * Code. When the token has expired it says so until Claude Code renews it.
 *
 * `state` is one of:
 *   { status: 'ok', session: {percent, resetsAt}, week: {percent, resetsAt}, updatedAt }
 *     (percent 0–100; resetsAt epoch ms, or null when no session has started)
 *   { status: 'signedOut' }   no Claude Code sign-in on this Mac (`claude auth login` makes one)
 *   { status: 'expired' }     the sign-in needs Claude Code to renew it
 *   { status: 'error' }       and no earlier numbers to fall back on
 *   { status: 'loading' }
 */
export class ClaudeUsage extends EventEmitter {
  /** @param {{enabled?: () => boolean}} [opts] enabled: whether it's wanted now (Settings → Usage); while not, nothing is read */
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
    const auth = await readCredentials();
    if (!auth) return this.#set({ status: 'signedOut' });
    if (auth.expiresAt && auth.expiresAt < Date.now()) return this.#set({ status: 'expired' });
    try {
      const res = await fetch(ENDPOINT, {
        headers: { authorization: `Bearer ${auth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 401) return this.#set({ status: 'expired' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.#set({ status: 'ok', session: windowOf(data.five_hour), week: windowOf(data.seven_day), updatedAt: Date.now() });
    } catch (err) {
      log.warn('[usage]', err.message);
      if (this.state.status !== 'ok') this.#set({ status: 'error' });
    }
  }

  #set(state) {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.emit('change', state);
  }
}

function windowOf(w) {
  const resetsAt = w?.resets_at ? Date.parse(w.resets_at) : NaN;
  return {
    percent: Math.max(0, Math.min(100, Math.round(Number(w?.utilization) || 0))),
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
  };
}

/** Claude Code's OAuth sign-in: {accessToken, expiresAt}, or null when there isn't one. */
async function readCredentials() {
  const raw = (await keychain().catch(() => null)) ||
    (await fs.readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8').catch(() => null));
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    return oauth?.accessToken ? { accessToken: oauth.accessToken, expiresAt: Number(oauth.expiresAt) || 0 } : null;
  } catch {
    return null;
  }
}

function keychain() {
  return new Promise((resolve, reject) =>
    execFile('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 60000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))),
  );
}
