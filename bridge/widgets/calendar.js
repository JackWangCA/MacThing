import { EventEmitter } from 'node:events';
import { log } from '../log.js';

const REFRESH_MS = 5 * 60 * 1000;
const DAYS_AHEAD = 7;

/**
 * Upcoming events from the Mac's Calendar app (via CarThingHelper / EventKit), limited to the
 * calendars chosen on the settings page. Refreshes on a timer and whenever the helper reports
 * the EventKit store changed.
 *
 * `state` is { status: 'ok', events: [{title, location, start, end, allDay, calendar, calendarId, color}] }
 * or { status: 'denied' | 'notDetermined' | 'restricted' | 'error' | 'loading' }.
 */
export class Calendar extends EventEmitter {
  constructor(helper, settings) {
    super();
    this.helper = helper;
    this.settings = settings;
    this.state = { status: 'loading' };
    this.all = []; // everything the helper last returned, before the calendar filter
    this.timer = null;
  }

  start() {
    this.refresh();
    setInterval(() => this.refresh(), REFRESH_MS);
    this.helper.on('eventKitChanged', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refresh(), 1000);
    });
    // Picking different calendars re-filters what we already have — no need to ask the Mac again.
    this.settings?.on('change', (values, keys) => {
      if (keys.includes('calendars') && this.state.status === 'ok') this.#set({ status: 'ok', events: this.#chosen() });
    });
  }

  /** Every calendar unless the settings name some (an id we no longer know about is ignored). */
  #chosen() {
    const ids = this.settings?.get().calendars;
    if (!Array.isArray(ids)) return this.all;
    return this.all.filter((e) => ids.includes(e.calendarId));
  }

  async refresh() {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + DAYS_AHEAD + 1);
    try {
      const r = await this.helper.events(from.getTime(), to.getTime());
      this.all = r.ok ? r.events : [];
      this.#set(r.ok ? { status: 'ok', events: this.#chosen() } : { status: r.status || 'error' });
    } catch (err) {
      log.warn('[calendar]', err.message);
      if (this.state.status !== 'ok') this.#set({ status: 'error' });
    }
  }

  #set(state) {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.emit('change', state);
  }
}
