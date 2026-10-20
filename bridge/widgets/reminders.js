import { EventEmitter } from 'node:events';

// Task reminders (Settings → Reminders): "Drink water" every 45 minutes, and so on, shown as a
// card on the device. First pass; see the open questions in the PR.
//
// Each reminder counts only the time you're at the Mac: unlocked, display awake, not asleep, and
// some keyboard or mouse input in the last AWAY_MS. Time away doesn't count, and being away for a
// whole interval starts the count over (you got up anyway), so a reminder never fires the moment
// you sit back down, and never piles up overnight.

export const AWAY_MS = 5 * 60000; // this long with no input on the Mac counts as away
export const EVERY_MINUTES = [15, 20, 30, 45, 60, 90, 120];
export const MAX_REMINDERS = 8;
export const MAX_TEXT = 40;

/**
 * One step of a reminder's count. `entry` is { activeMs, awayMs }, the time at the Mac since it
 * last fired and the current stretch away. Returns the next entry and whether it fires now.
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
 * Counts each enabled reminder from `settings.reminders` and emits 'due' (reminder) when one is
 * up. `presence()` resolves whether you're at the Mac right now.
 */
export class Reminders extends EventEmitter {
  constructor({ settings, presence, tickMs = 30000 }) {
    super();
    this.settings = settings;
    this.presence = presence;
    this.tickMs = tickMs;
    this.entries = new Map(); // reminder id → { activeMs, awayMs }
    this.timer = null;
    this.last = 0;
  }

  start() {
    this.last = Date.now();
    this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick() {
    const now = Date.now();
    // A long gap means the Mac slept through it: that's time away, not time at the Mac.
    const dtMs = Math.min(now - this.last, this.tickMs * 4);
    const slept = now - this.last > this.tickMs * 4;
    this.last = now;
    const list = (this.settings.get().reminders || []).filter((r) => r.on);
    for (const id of this.entries.keys()) if (!list.some((r) => r.id === id)) this.entries.delete(id);
    if (!list.length) return;
    const present = !slept && (await this.presence());
    for (const r of list) {
      const everyMs = r.every * 60000;
      const prev = this.entries.get(r.id) || { activeMs: 0, awayMs: 0 };
      const { entry, fire } = step(prev, { dtMs: slept ? everyMs : dtMs, present }, everyMs);
      this.entries.set(r.id, entry);
      if (fire) this.emit('due', { id: r.id, text: r.text, every: r.every, at: now });
    }
  }

  /** Shows one now, from the settings page's Test button, and restarts its count. */
  fire(id) {
    const r = (this.settings.get().reminders || []).find((x) => x.id === id);
    if (!r) return false;
    this.entries.set(r.id, { activeMs: 0, awayMs: 0 });
    this.emit('due', { id: r.id, text: r.text, every: r.every, at: Date.now() });
    return true;
  }
}
