import { EventEmitter } from 'node:events';
import { log } from '../log.js';

const REFRESH_MS = 5 * 60 * 1000;
const DAYS_AHEAD = 7;

/**
 * Due reminders from the Mac's Reminders app (via CarThingHelper / EventKit), limited to the
 * lists chosen on the settings page. Refreshes on a timer and whenever the helper reports the
 * EventKit store changed.
 *
 * Only incomplete reminders that have a due date, overdue ones included — the helper's predicate
 * does both. Something with no due date never appears, which is the point of the screen.
 *
 * `state` is { status: 'ok', reminders: [{title, notes, due, hasTime, priority, list, listId, color}] }
 * or { status: 'denied' | 'notDetermined' | 'restricted' | 'error' | 'loading' }.
 */
export class Reminders extends EventEmitter {
  constructor(helper, settings) {
    super();
    this.helper = helper;
    this.settings = settings;
    this.state = { status: 'loading' };
    this.all = []; // everything the helper last returned, before the list filter
    this.timer = null;
  }

  start() {
    this.refresh();
    setInterval(() => this.refresh(), REFRESH_MS);
    this.helper.on('eventKitChanged', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refresh(), 1000);
    });
    // Picking different lists re-filters what we already have — no need to ask the Mac again.
    this.settings?.on('change', (values, keys) => {
      if (keys.includes('reminderLists') && this.state.status === 'ok')
        this.#set({ status: 'ok', reminders: this.#chosen() });
    });
  }

  /** Every list unless the settings name some (an id we no longer know about is ignored). */
  #chosen() {
    const ids = this.settings?.get().reminderLists;
    if (!Array.isArray(ids)) return this.all;
    return this.all.filter((r) => ids.includes(r.listId));
  }

  async refresh() {
    const to = new Date();
    to.setHours(0, 0, 0, 0);
    to.setDate(to.getDate() + DAYS_AHEAD + 1);
    try {
      const r = await this.helper.reminders(to.getTime());
      this.all = r.ok ? r.reminders : [];
      this.#set(r.ok ? { status: 'ok', reminders: this.#chosen() } : { status: r.status || 'error' });
    } catch (err) {
      log.warn('[reminders]', err.message);
      if (this.state.status !== 'ok') this.#set({ status: 'error' });
    }
  }

  #set(state) {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.emit('change', state);
  }
}
