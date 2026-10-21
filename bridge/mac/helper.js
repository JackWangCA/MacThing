import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { log } from '../log.js';

/**
 * Talks to native/bin/CarThingHelper.app (location + calendar). It runs as its own app so
 * macOS asks for and remembers Location Services / Calendars permission for "Car Thing Helper".
 * Emits 'calendarChanged' and 'locationAuthorization' notices from the helper.
 */
// The exit handler waits 2s before respawning, so a recycle has to outlast that.
const RECYCLE_WAIT_MS = 8000;

export class MacHelper extends EventEmitter {
  constructor(binDir) {
    super();
    this.bin = path.join(binDir, 'CarThingHelper.app', 'Contents', 'MacOS', 'CarThingHelper');
    this.pending = new Map();
    this.nextId = 1;
    this.proc = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    const proc = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.proc = proc;
    queueMicrotask(() => this.emit('started'));
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return log.warn('[helper] unparseable line', line.slice(0, 200));
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        resolve(msg);
      } else if (msg.event) {
        this.emit(msg.event, msg);
      }
    });
    proc.on('exit', (code) => {
      this.proc = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('helper exited'));
      }
      this.pending.clear();
      if (this.stopped) return;
      log.warn(`[helper] exited (${code}); restarting in 2s`);
      setTimeout(() => this.start(), 2000);
    });
  }

  stop() {
    this.stopped = true;
    this.proc?.stdin.end();
  }

  /**
   * Trade this helper for a new one, and wait for it to come up.
   *
   * A helper geocodes on its first location request and no other: every one after it runs the
   * 20-second deadline out and answers with the fix CoreLocation already had and no place name.
   * `startUpdatingLocation()` wakes nothing on a Mac that has not moved, so the delegate never
   * fires again and the fix goes stale with it — after a while the weather is pinned to wherever
   * the bridge last started, whatever the Mac does. Restarting is the one thing known to work.
   *
   * Callers must rate-limit this: it kills whatever else was in flight (those requests reject
   * with 'helper exited' and are retried on their own schedules), and recycling in a loop would
   * be worse than a stale name. Resolves false if there was nothing to replace, or the
   * replacement did not arrive in time.
   */
  recycle() {
    const old = this.proc;
    if (this.stopped || !old) return Promise.resolve(false);
    log.info('[helper] restarting to get a fresh location fix');
    return new Promise((resolve) => {
      let timer = null;
      const ready = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once('started', ready);
      timer = setTimeout(() => {
        this.off('started', ready);
        resolve(Boolean(this.proc));
      }, RECYCLE_WAIT_MS);
      old.kill();
    });
  }

  /** Permission prompts can sit on screen for a while, hence the long default timeout. */
  request(cmd, params = {}, timeoutMs = 90000) {
    if (!this.proc) return Promise.reject(new Error('helper not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`helper ${cmd} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ id, cmd, ...params })}\n`);
    });
  }

  status() {
    return this.request('status', {}, 5000);
  }

  /** @returns {Promise<{ok, status, lat?, lon?, name?, region?, country?}>} */
  location() {
    return this.request('location');
  }

  /** @returns {Promise<{ok, status, events?: Array<{title, location, start, end, allDay, calendar, calendarId, color}>}>} */
  events(from, to) {
    return this.request('events', { from, to });
  }

  /** Every event calendar on the Mac. @returns {Promise<{ok, status, calendars?: Array<{id, title, color, account}>}>} */
  calendars() {
    return this.request('calendars');
  }

  /**
   * Incomplete reminders due by `to`, overdue ones included and undated ones left out.
   * @returns {Promise<{ok, status, reminders?: Array<{title, notes, due, hasTime, priority, list, listId, color}>}>}
   */
  reminders(to) {
    return this.request('reminders', { to });
  }

  /** Every reminder list on the Mac. @returns {Promise<{ok, status, reminderLists?: Array<{id, title, color, account}>}>} */
  reminderLists() {
    return this.request('reminderLists');
  }
}
