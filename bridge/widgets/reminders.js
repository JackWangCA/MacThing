import { EventEmitter } from 'node:events';

// Task reminders (Settings → Reminders): "Drink water" every 45 minutes, "Stretch" at 3:00, and so
// on, shown as a card on the device.
//
// Nothing fires outside the active hours (Settings → Reminders → Active hours: days of the week and
// a from–to time, or any time).
//
// "Every N min" reminders count only the time you're at the Mac: unlocked, display awake, not
// asleep, and some keyboard or mouse input in the last AWAY_MS. Time away (or outside the active
// hours) doesn't count, and being away for a whole interval starts the count over (you got up
// anyway), so a reminder never fires the moment you sit back down, and never piles up overnight.
// The count restarts when the card appears, not when it's dismissed.
//
// "At times" reminders show at each time you set, if you're at the Mac then; if you're away, once
// when you're back, as long as it's still within the active hours that day. Never more than once
// for the same time, and a time outside the active hours never shows.

export const AWAY_MS = 5 * 60000; // this long with no input on the Mac counts as away
export const EVERY_MINUTES = [15, 20, 30, 45, 60, 90, 120];
export const MAX_REMINDERS = 8;
export const MAX_TIMES = 6;
export const MAX_TEXT = 40;
export const DAY_MINUTES = 24 * 60;

/** Whether `date` falls inside the active hours ({ days: [0 = Sunday …], from, to } in minutes since midnight), or null = any time. */
export function inActiveHours(date, hours) {
  if (!hours) return true;
  const minute = date.getHours() * 60 + date.getMinutes();
  return hours.days.includes(date.getDay()) && hours.from <= minute && minute < hours.to;
}

/**
 * One step of an "every" reminder's count. `entry` is { activeMs, awayMs }, the time at the Mac
 * since it last fired and the current stretch away. Returns the next entry and whether it fires.
 */
export function step(entry, { dtMs, present }, everyMs) {
  if (!present) {
    const awayMs = entry.awayMs + dtMs;
    // Away for a whole interval: start over.
    return { entry: { activeMs: awayMs >= everyMs ? 0 : entry.activeMs, awayMs }, fire: false };
  }
  const activeMs = entry.activeMs + dtMs;
  if (activeMs >= everyMs) return { entry: { activeMs: 0, awayMs: 0 }, fire: true };
  return { entry: { activeMs, awayMs: 0 }, fire: false };
}

/**
 * The latest of today's `times` (minutes since midnight) that has come and not been shown yet:
 * after `lastMs` and at or before `now`. Its timestamp, or null. A missed time stays due only
 * while `now` is still within the active hours, which the caller checks.
 */
export function dueSlot(times, lastMs, now) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  let due = null;
  for (const t of times) {
    const at = new Date(midnight);
    at.setMinutes(t);
    const ms = at.getTime();
    if (ms > lastMs && ms <= now.getTime() && (due === null || ms > due)) due = ms;
  }
  return due;
}

/**
 * Tracks each enabled reminder from `settings.reminders` and emits 'due' (reminder) when one is
 * up. `presence()` resolves whether you're at the Mac right now.
 */
export class Reminders extends EventEmitter {
  constructor({ settings, presence, tickMs = 30000, now = () => new Date() }) {
    super();
    this.settings = settings;
    this.presence = presence;
    this.tickMs = tickMs;
    this.now = now;
    // reminder id → { activeMs, awayMs } (every) or { lastMs, key } (times)
    this.entries = new Map();
    this.timer = null;
    this.last = 0;
  }

  start() {
    this.last = this.now().getTime();
    this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick() {
    const date = this.now();
    const now = date.getTime();
    // A long gap means the Mac slept through it: that's time away, not time at the Mac.
    const slept = now - this.last > this.tickMs * 4;
    const dtMs = now - this.last;
    this.last = now;
    const { reminders = [], activeHours = null } = this.settings.get();
    const list = reminders.filter((r) => r.on);
    for (const id of this.entries.keys()) if (!list.some((r) => r.id === id)) this.entries.delete(id);
    if (!list.length) return;
    const active = inActiveHours(date, activeHours);
    const present = active && !slept && (await this.presence());
    for (const r of list) {
      if (r.repeat === 'times') {
        // Times you add (or change) count from now, so a time already past today doesn't fire.
        const key = (r.times || []).join(',');
        let entry = this.entries.get(r.id);
        if (!entry || entry.key !== key) this.entries.set(r.id, (entry = { lastMs: now, key }));
        // Times outside the active hours never show.
        const times = activeHours ? (r.times || []).filter((t) => activeHours.from <= t && t < activeHours.to) : r.times || [];
        const slot = present ? dueSlot(times, entry.lastMs, date) : null;
        if (slot !== null) {
          entry.lastMs = now;
          this.emit('due', this.#message(r, slot));
        }
        continue;
      }
      const everyMs = r.every * 60000;
      const prev = this.entries.get(r.id);
      const start = prev && 'activeMs' in prev ? prev : { activeMs: 0, awayMs: 0 };
      const { entry, fire } = step(start, { dtMs: slept ? everyMs : dtMs, present }, everyMs);
      this.entries.set(r.id, entry);
      if (fire) this.emit('due', this.#message(r, now));
    }
  }

  #message(r, at) {
    return { id: r.id, text: r.text, repeat: r.repeat, every: r.every, at };
  }

  /** Shows one now, from the settings page's Show now button. An "every" count restarts. */
  fire(id) {
    const r = (this.settings.get().reminders || []).find((x) => x.id === id);
    if (!r) return false;
    const now = this.now().getTime();
    if (r.repeat !== 'times') this.entries.set(r.id, { activeMs: 0, awayMs: 0 });
    this.emit('due', this.#message(r, now));
    return true;
  }
}
