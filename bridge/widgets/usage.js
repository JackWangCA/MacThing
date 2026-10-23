import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import { isRenewed, renewClaudeCredentials } from './claude-auth.js';

const REFRESH_MS = 5 * 60 * 1000;
// Opening the usage view asks for fresh numbers, but no more often than this.
const ASK_MIN_MS = 60 * 1000;
const RENEW_MIN_MS = 5 * 60 * 1000;
const CACHE_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'carthing-now-playing', 'claude-usage.json');
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
// The session's recent burn is measured across the last BURN_MIN_MS to BURN_MAX_MS of readings.
const BURN_MIN_MS = 10 * 60 * 1000;
const BURN_MAX_MS = 20 * 60 * 1000;

/**
 * Claude plan usage for the Clock screen's usage view: the current five-hour session and the
 * week, the same numbers Claude Code's /usage shows. It reads Claude Code's own sign-in (the
 * "Claude Code-credentials" Keychain item, or ~/.claude/.credentials.json) and only ever uses
 * the access token, never the refresh token — refreshing would rotate it out from under Claude
 * Code. When the access token expires, a quiet SDK initialization asks the installed Claude
 * Code to renew its own credentials, without a model request or an interactive login.
 *
 * `state` is one of:
 *   { status: 'ok', session: {percent, resetsAt, burn?}, week: {percent, resetsAt}, updatedAt }
 *     (percent 0–100; resetsAt epoch ms, or null when no session has started; burn
 *     {percent, ms}: how much of the session was used over the last 10–20 minutes, once
 *     this bridge has readings that far apart in the same session)
 *   { status: 'signedOut' }   no Claude Code sign-in on this Mac (`claude auth login` makes one)
 *   { status: 'expired' }     the sign-in needs Claude Code to renew it
 *   { status: 'rateLimited', retryAt } server asked us to wait before fetching again
 *   { status: 'error' }       and no earlier numbers to fall back on
 *   { status: 'loading' }
 */
export class ClaudeUsage extends EventEmitter {
  /** @param {{enabled?: () => boolean}} [opts] enabled: whether it's wanted now (Settings → Usage); while not, nothing is read */
  constructor({ enabled = () => true, readCredentials: read = readCredentials,
    renewCredentials, fetch: request = globalThis.fetch, now = Date.now, cacheFile = CACHE_FILE } = {}) {
    super();
    this.enabled = enabled;
    this.state = { status: 'loading' };
    this.inflight = null;
    this.lastTry = 0;
    this.lastRenewal = -Infinity;
    this.readCredentials = read;
    this.renewCredentials = renewCredentials || (auth => renewClaudeCredentials(read, auth));
    this.request = request;
    this.now = now;
    this.cacheFile = cacheFile;
    this.cacheLoaded = false;
    this.tokenHash = null;
    this.snapshot = null;
    this.snapshotVerified = false;
    this.retryAt = 0;
    this.failures = 0;
    this.retryReason = 'rateLimited';
    this.running = false;
    // Recent session readings, {at, used, resetsAt}, for the session's burn.
    this.readings = [];
  }

  start() {
    this.running = true;
    this.refresh();
  }

  /** The device opened the usage view: fresh numbers, unless they were just fetched. */
  ask() {
    if (this.now() - this.lastTry < ASK_MIN_MS) return this.inflight;
    return this.refresh();
  }

  refresh() {
    if (!this.enabled()) { this.#schedule(); return Promise.resolve(); }
    this.inflight ??= this.#refresh().finally(() => { this.inflight = null; this.#schedule(); });
    return this.inflight;
  }

  async #refresh() {
    try {
      await this.#loadCache();
      let auth = await this.readCredentials(), attemptedRenewal = false;
      if (!auth) return this.#authFailure('signedOut');
      this.#useCredentials(auth);
      if (this.retryAt > this.now()) {
        this.#waiting();
        return;
      }
      if (this.#usableSnapshot() && this.now() - this.lastTry < ASK_MIN_MS) return;
      this.lastTry = this.now();
      if (auth.expiresAt && auth.expiresAt <= this.now()) {
        auth = await this.#renew(auth);
        attemptedRenewal = true;
        if (!auth) return this.#authFailure('expired');
        this.#useCredentials(auth);
      }
      let res = await this.#request(auth);
      if (res.status === 401 && !attemptedRenewal) {
        auth = await this.#renew(auth);
        if (auth) { this.#useCredentials(auth); res = await this.#request(auth); }
      }
      if (res.status === 401) return this.#authFailure('expired');
      if (res.status === 429) {
        this.retryReason = 'rateLimited';
        this.failures++;
        const backoff = Math.min(MAX_BACKOFF_MS, REFRESH_MS * 2 ** Math.min(this.failures - 1, 4));
        const hint = res.headers?.get('retry-after');
        const seconds = hint == null || hint.trim() === '' ? NaN : Number(hint);
        const requested = Number.isFinite(seconds) ? this.now() + Math.max(0, seconds) * 1000 : Date.parse(hint);
        this.retryAt = Math.max(this.now() + backoff, Number.isFinite(requested) ? requested : 0);
        this.#waiting();
        await this.#saveCache();
        log.warn('[Claude usage]', `rate limited; next check in ${Math.ceil((this.retryAt - this.now()) / 60000)}m`);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.retryAt = 0;
      this.failures = 0;
      const session = windowOf(data.five_hour);
      const burn = this.#burn(data.five_hour, session.resetsAt);
      if (burn) session.burn = burn;
      this.snapshot = { status: 'ok', session, week: windowOf(data.seven_day), updatedAt: this.now() };
      this.#set(this.snapshot);
      await this.#saveCache();
    } catch (err) {
      log.warn('[Claude usage]', err.message);
      this.retryReason = 'error';
      this.retryAt = this.now() + REFRESH_MS;
      this.#set(this.#usableSnapshot() ? { ...this.snapshot, stale: true, retryAt: this.retryAt } : { status: 'error', retryAt: this.retryAt });
      await this.#saveCache();
    }
  }

  /** Session use since the oldest reading 10–20 minutes back in the same session, or null. Readings
   *  keep the API's unrounded utilization so a short span isn't lost to rounding. */
  #burn(raw, resetsAt) {
    const now = this.now(), used = Number(raw?.utilization);
    // A new session (its reset moved) or a gap starts the history again.
    this.readings = this.readings.filter(r => now - r.at <= BURN_MAX_MS && sameReset(r.resetsAt, resetsAt));
    if (!Number.isFinite(used) || !resetsAt) { this.readings = []; return null; }
    this.readings.push({ at: now, used, resetsAt });
    const from = this.readings.find(r => now - r.at >= BURN_MIN_MS);
    return from ? { percent: Math.max(0, used - from.used), ms: now - from.at } : null;
  }

  #schedule() {
    if (!this.running) return;
    clearTimeout(this.timer);
    const delay = this.retryAt > this.now() ? this.retryAt - this.now() : REFRESH_MS;
    this.timer = setTimeout(() => this.refresh(), Math.min(delay, 2147483647));
  }

  #usableSnapshot() {
    const s = this.snapshot;
    return this.snapshotVerified && s?.status === 'ok' && Number.isFinite(s.updatedAt) && s.updatedAt <= this.now() &&
      this.now() - s.updatedAt < MAX_CACHE_AGE_MS && [s.session, s.week].every(w =>
        w && Number.isFinite(w.percent) && w.percent >= 0 && w.percent <= 100 &&
        (w.resetsAt === null || (Number.isFinite(w.resetsAt) && w.resetsAt > this.now())));
  }

  #useCredentials(auth) {
    // Bind cached readings to the current login without persisting any credential.
    const hash = createHash('sha256').update(auth.accessToken).digest('hex');
    if (this.tokenHash && this.tokenHash !== hash) {
      this.snapshot = null;
      this.retryAt = 0;
      this.failures = 0;
      this.lastTry = 0;
      this.#set({ status: 'loading' });
    }
    this.tokenHash = hash;
    this.snapshotVerified = true;
    if (this.#usableSnapshot() && this.state.status !== 'ok') this.#set({ ...this.snapshot, stale: true, retryAt: this.retryAt });
  }

  #waiting() {
    this.#set(this.#usableSnapshot() ? { ...this.snapshot, stale: true, retryAt: this.retryAt } : { status: this.retryReason, retryAt: this.retryAt });
  }

  async #authFailure(status) {
    this.snapshot = null;
    this.retryAt = 0;
    this.failures = 0;
    this.#set({ status });
    await this.#saveCache();
  }

  async #loadCache() {
    if (this.cacheLoaded || !this.cacheFile) return;
    this.cacheLoaded = true;
    try {
      const saved = JSON.parse(await fs.readFile(this.cacheFile, 'utf8'));
      if (saved.version !== 1 || !/^[a-f0-9]{64}$/.test(saved.tokenHash)) return;
      this.tokenHash = saved.tokenHash;
      this.snapshot = saved.snapshot;
      this.lastTry = Number.isFinite(saved.lastTry) && saved.lastTry <= this.now() ? saved.lastTry : 0;
      this.retryReason = saved.retryReason === 'error' ? 'error' : 'rateLimited';
      this.retryAt = Number.isFinite(saved.retryAt) ? saved.retryAt : 0;
      this.failures = Number.isInteger(saved.failures) ? Math.max(0, Math.min(5, saved.failures)) : 0;
    } catch { /* Missing or invalid cache: fetch normally. */ }
  }

  async #saveCache() {
    if (!this.cacheFile || !this.tokenHash) return;
    try {
      const snapshot = this.#usableSnapshot() ? this.snapshot : null;
      const data = { version: 1, tokenHash: this.tokenHash, snapshot, retryAt: this.retryAt, retryReason: this.retryReason, failures: this.failures, lastTry: this.lastTry };
      await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
      const temp = `${this.cacheFile}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600 });
      await fs.rename(temp, this.cacheFile);
    } catch { log.warn('[Claude usage]', 'could not save usage cache'); }
  }

  #request(auth) {
    this.lastTry = this.now();
    return this.request(ENDPOINT, {
      headers: { authorization: `Bearer ${auth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15000),
    });
  }

  async #renew(previous) {
    // Claude Code may have renewed the token while our request was in flight.
    let auth = await this.readCredentials();
    if (isRenewed(auth, previous, this.now())) return auth;
    if (this.now() - this.lastRenewal < RENEW_MIN_MS) return null;
    this.lastRenewal = this.now();
    try { await this.renewCredentials(previous); }
    catch { log.warn('[usage]', 'Claude Code could not renew its sign-in'); }
    auth = await this.readCredentials();
    return isRenewed(auth, previous, this.now()) ? auth : null;
  }

  #set(state) {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.emit('change', state);
  }
}

// The API's reset time can wobble by a second or so between readings of the same session.
const sameReset = (a, b) => a && b && Math.abs(a - b) < 60 * 1000;

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
