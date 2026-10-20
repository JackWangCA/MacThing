import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';

// Individual spend on https://tokens.bottlerocket.tesla.com/usage-cost/individual :
// this UTC week’s cost for the signed-in user’s personal tokens, against the weekly
// dollar limits from Cost Control.
//
// Authenticated with one of the personal API tokens that site issues, sent as a bearer.
// Not as the tokens site itself: its Azure app registration is a single-page app with
// public client flows turned off, so it refuses every device-code redemption — carrying
// an Origin as AADSTS9002326, without one as AADSTS7000218.
//
// Driving a real browser session instead was tried and abandoned; native/bottlerocketauth/
// keeps the code and the reasons. The short version is that silent re-authorisation is
// Tesla's conditional-access policy to grant, not ours, and it stopped being granted — a
// personal token has no such problem, needs no refreshing, and is what the backend checks
// anyway.

const REFRESH_MS = 5 * 60 * 1000;
const THROTTLED_MS = 15 * 60 * 1000;
const ASK_MIN_MS = 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const API = 'https://backend.bottlerocket.tesla.com';
const SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'carthing-now-playing');
const TOKEN_FILE = path.join(SUPPORT, 'bottlerocket-token.json');
// The launch agent is given only PATH, so the settings page's token is the usual source.
// Started from a terminal instead, a token already in the environment saves setting it twice.
const ENV_KEYS = ['BOTTLEROCKET_TOKEN', 'ANTHROPIC_AUTH_TOKEN'];

/** Monday 00:00 UTC through the following Monday, the “Current Week” preset on the tokens site. */
export function weekBounds(now) {
  const e = new Date(now);
  const sinceMonday = (e.getUTCDay() + 6) % 7;
  const start = Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate() - sinceMonday);
  return { start, resetsAt: start + WEEK_MS };
}

function asList(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['items', 'tokens', 'data']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

/** Personal tokens, the same split the individual page uses (notes beginning “coder-”).
 *  With none tagged that way, every token on the account is counted. */
export function personalTokens(data) {
  const tokens = asList(data).filter((t) => t?.token_id);
  const coder = tokens.filter((t) => String(t.notes || '').toLowerCase().startsWith('coder-'));
  return coder.length ? coder : tokens;
}

function weeklyLimitUsd(policy) {
  const window = policy?.windows?.find((w) => w?.period === 'weekly');
  const limit = Number(window?.limit_usd);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

/** Sum of weekly dollar limits for these token ids. Null when none of them has a weekly limit. */
export function weeklyLimitFor(data, tokenIds) {
  const ids = new Set(tokenIds);
  let sum = 0;
  let any = false;
  for (const item of asList(data)) {
    if (!ids.has(item?.token_id)) continue;
    const limit = weeklyLimitUsd(item.spend_policy);
    if (limit == null) continue;
    sum += limit;
    any = true;
  }
  return any ? sum : null;
}

/** Total cost in the usage response, the same rollup as the tokens site’s Total Cost card. */
export function sumCost(data) {
  const results = data?.results ?? data;
  const rows = Array.isArray(results) ? results : Object.values(results || {}).flat();
  return rows.reduce((sum, row) => sum + (Number(row?.total_cost_usd) || 0), 0);
}

export function spendSummary({ tokens, limits, usage, now }) {
  const ids = personalTokens(tokens).map((t) => t.token_id);
  const spent = sumCost(usage);
  const limit = weeklyLimitFor(limits, ids);
  const { resetsAt } = weekBounds(now);
  return {
    status: 'ok',
    spent,
    limit,
    percent: limit > 0 ? (spent / limit) * 100 : null,
    resetsAt,
    updatedAt: now,
  };
}

/**
 * Bottlerocket weekly spend for the Clock screen.
 * `state` is one of:
 *   { status: 'ok', spent, limit, percent, resetsAt, updatedAt }
 *   { status: 'noToken' }     no API token set on the settings page yet
 *   { status: 'badToken' }    there is one, and Bottlerocket refused it
 *   { status: 'none' }        the token works, but its account has no tokens to count
 *   { status: 'rateLimited', retryAt }
 *   { status: 'error', retryAt, detail }
 *   { status: 'loading' }
 */
export class BottlerocketUsage extends EventEmitter {
  constructor({
    enabled = () => true, request = globalThis.fetch, now = Date.now,
    tokenFile = TOKEN_FILE, env = process.env,
  } = {}) {
    super();
    this.enabled = enabled;
    this.request = request;
    this.now = now;
    this.tokenFile = tokenFile;
    this.env = env;
    this.state = { status: 'loading' };
    this.inflight = null;
    this.lastTry = 0;
    this.running = false;
  }

  start() {
    this.running = true;
    this.refresh();
  }

  ask() {
    if (this.now() - this.lastTry < ASK_MIN_MS) return this.inflight;
    return this.refresh();
  }

  refresh() {
    if (!this.enabled()) { this.#schedule(); return Promise.resolve(); }
    this.inflight ??= this.#refresh().finally(() => { this.inflight = null; this.#schedule(); });
    return this.inflight;
  }

  /** Whether a token is set at all, for the settings page. Never the token itself. */
  async hasToken() {
    return Boolean(await this.#token());
  }

  /** Keeps the token the settings page was given, readable only by its owner. Null clears it. */
  async setToken(token) {
    const value = String(token || '').trim();
    if (!value) {
      await fs.rm(this.tokenFile, { force: true });
    } else {
      await fs.mkdir(path.dirname(this.tokenFile), { recursive: true });
      const temp = `${this.tokenFile}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify({ token: value }), { mode: 0o600 });
      await fs.rename(temp, this.tokenFile);
    }
    this.lastTry = 0; // a new token deserves a look straight away
    return this.refresh();
  }

  async #token() {
    try {
      const saved = JSON.parse(await fs.readFile(this.tokenFile, 'utf8'));
      if (saved?.token) return String(saved.token).trim();
    } catch { /* nothing saved yet */ }
    for (const key of ENV_KEYS) {
      if (this.env?.[key]) return String(this.env[key]).trim();
    }
    return null;
  }

  async #refresh() {
    try {
      const token = await this.#token();
      if (!token) return this.#set({ status: 'noToken' });
      this.lastTry = this.now();
      this.#set(await this.#loadSpend(token));
    } catch (err) {
      // A refused token stays where it is: only whoever typed it can tell if it was a typo
      // or an expiry, and throwing it away would lose the evidence either way.
      if (err.status === 401 || err.status === 403) {
        log.warn('[Bottlerocket usage] token refused', `HTTP ${err.status}`);
        return this.#set({ status: 'badToken', detail: `Bottlerocket refused it (HTTP ${err.status}).` });
      }
      log.warn('[Bottlerocket usage]', err.message);
      const retryAt = this.now() + (err.status === 429 ? THROTTLED_MS : REFRESH_MS);
      this.#set(this.state.status === 'ok'
        ? { ...this.state, stale: true, retryAt }
        : { status: err.status === 429 ? 'rateLimited' : 'error', retryAt, detail: err.message });
    }
  }

  async #loadSpend(token) {
    const { start } = weekBounds(this.now());
    const tokensRes = await this.#api(token, '/v2/tokens/me');
    const tokens = await tokensRes.json();
    const ids = personalTokens(tokens).map((t) => t.token_id);
    if (!ids.length) return { status: 'none' };
    const limitsRes = await this.#api(token, '/v2/spend-limits/team?include_indirect_reports=false');
    const usageRes = await this.#api(token, '/v2/tokens/analytics/usage', {
      method: 'POST',
      body: {
        token_ids: ids,
        from_timestamp: new Date(start).toISOString(),
        to_timestamp: new Date(this.now()).toISOString(),
        use_case: 'personal',
      },
    });
    return spendSummary({
      tokens, limits: await limitsRes.json(), usage: await usageRes.json(), now: this.now(),
    });
  }

  async #api(token, path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await this.request(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      // undici calls every transport problem "fetch failed"; only the cause says which.
      const cause = err.cause?.code || err.cause?.message;
      throw new Error(cause ? `${err.message} (${cause})` : err.message);
    }
    if ([401, 403, 429].includes(res.status)) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  #schedule() {
    if (!this.running) return;
    clearTimeout(this.timer);
    const wait = this.state.retryAt > this.now() ? this.state.retryAt - this.now() : REFRESH_MS;
    this.timer = setTimeout(() => this.refresh(), wait);
  }

  #set(state) {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.emit('change', state);
  }
}
