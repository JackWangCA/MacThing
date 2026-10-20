import { execFile } from 'node:child_process';
import path from 'node:path';
import { log } from '../log.js';

/**
 * Bearer tokens for backend.bottlerocket.tesla.com, from native/bin/BottlerocketAuth.app.
 *
 * The app signs in with Tesla SSO once, in a window, and after that mints a fresh token from
 * the saved session without anyone watching — see native/bottlerocketauth/main.swift for why it
 * has to drive the dashboard to do it. Nothing is stored on this side: the token lives in
 * memory until it expires, and the session itself is WebKit's, under the app's bundle id.
 */

const SILENT_MS = 90 * 1000; // two 30s attempts, plus room for the SSO redirects
const LOGIN_MS = 6 * 60 * 1000; // a password and a phone prompt
const SIGNOUT_MS = 30 * 1000;
// Tokens run about an hour. Re-minting takes ~5s, so retire them early rather than hand the
// widget one that expires mid-request.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const FALLBACK_TTL_MS = 30 * 60 * 1000;
// Signed out, every silent attempt costs a minute of offscreen WebKit to learn nothing. The
// widget still polls every five, so back right off and wait for the Sign in button instead.
const AFTER_FAILURE_MS = 30 * 60 * 1000;

/** When a JWT says it expires, in ms. Null if it isn't one, or doesn't say. */
export function expiryOf(token) {
  const payload = String(token).split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(json?.exp) ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

export class BottlerocketAuth {
  constructor({ binDir, run = runApp, now = Date.now } = {}) {
    this.bin = path.join(binDir, 'BottlerocketAuth.app', 'Contents', 'MacOS', 'BottlerocketAuth');
    this.run = run;
    this.now = now;
    this.cached = null; // { token, expiresAt }
    this.inflight = null;
    this.signedIn = null; // null until the first attempt says one way or the other
    this.failedAt = 0;
  }

  /** A usable token, or null if nobody has signed in yet. Concurrent callers share one mint. */
  token() {
    if (this.cached && this.cached.expiresAt > this.now()) return Promise.resolve(this.cached.token);
    if (this.signedIn === false && this.now() - this.failedAt < AFTER_FAILURE_MS) {
      return Promise.resolve(null);
    }
    this.inflight ??= this.#mint([]).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Opens the sign-in window and waits for it. @returns {Promise<{ok, reason?}>} */
  async signIn() {
    if (this.inflight) await this.inflight.catch(() => {}); // don't open two WebKit sessions at once
    this.inflight = this.#mint(['--login'], LOGIN_MS).finally(() => { this.inflight = null; });
    const token = await this.inflight;
    return token ? { ok: true } : { ok: false, reason: this.lastReason || 'notSignedIn' };
  }

  /** Throws the WebKit session away, so the next sign-in starts from a password. */
  async signOut() {
    if (this.inflight) await this.inflight.catch(() => {});
    this.cached = null;
    const result = await this.run(this.bin, ['--signout'], SIGNOUT_MS);
    // Signed out either way as far as this side is concerned: the token is gone, and a jar that
    // refused to empty is something the next silent mint will discover on its own.
    this.signedIn = false;
    this.failedAt = this.now();
    if (!result?.ok) log.warn('[Bottlerocket auth] sign-out', result?.detail || 'the session would not clear');
    return { ok: Boolean(result?.ok) };
  }

  /** Throws away a token the backend wouldn't take, so the next call mints another. */
  forget() {
    this.cached = null;
  }

  /** Whether a silent attempt would be made right now, or is being held off after a failure. */
  get backingOff() {
    return this.signedIn === false && this.now() - this.failedAt < AFTER_FAILURE_MS;
  }

  async #mint(args, timeout = SILENT_MS) {
    const result = await this.run(this.bin, args, timeout);
    if (!result?.ok || !result.token) {
      this.lastReason = result?.reason || 'error';
      this.failedAt = this.now();
      this.signedIn = this.lastReason === 'needsLogin' || this.lastReason === 'notSignedIn'
        ? false
        : this.signedIn;
      if (result?.detail) log.warn('[Bottlerocket auth]', `${this.lastReason}: ${result.detail}`);
      return null;
    }
    this.lastReason = null;
    this.signedIn = true;
    const expiry = expiryOf(result.token);
    this.cached = {
      token: result.token,
      expiresAt: expiry ? expiry - EXPIRY_MARGIN_MS : this.now() + FALLBACK_TTL_MS,
    };
    return result.token;
  }
}

/** Runs the app and reads its one line of JSON. Its stderr is WebKit's noise, and dropped. */
function runApp(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout) => {
      const line = String(stdout || '').trim().split('\n').filter(Boolean).pop();
      if (line) {
        try {
          return resolve(JSON.parse(line));
        } catch { /* fall through to the error below */ }
      }
      resolve({ ok: false, reason: 'error', detail: err ? err.message : 'no reply from the helper' });
    });
  });
}
