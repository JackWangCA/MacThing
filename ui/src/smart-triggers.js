// What Smart switching reacts to (smart.js does the switching). Plain functions over the Mac's
// readings, with no Vue, so the tests can drive them.
import { SESSION_MS, paceK, burnK, fires } from './usage.js';
import { isWet } from './weather.js';

const HOUR = 3600000;

/** How hot the session reads on the Claude-o-meter: 0 calm, 1 🔥, 2 🔥🔥, 3 💀 (at the limit). The
 *  fires follow the burn right now when the Mac has one, else the average so far (see paceNumber). */
export function heat(usage, now) {
  const w = usage.session, k = paceK(w, SESSION_MS, now);
  if (!Number.isFinite(k)) return 3;
  return [...fires(burnK(w, usage.updatedAt, now) ?? k)].length;
}

// A window that ends after this much use is worth showing: the allowance is back.
export const RESET_MIN_PERCENT = 80;

// No fires for this long and the session counts as cooled off: fires coming back are news again.
export const COOL_MS = 15 * 60000;

/**
 * Watches one provider's usage. check(usage, now) returns 'hot' when the session's fires climb
 * higher than they have been this session (see heat), or come back after COOL_MS without any,
 * 'reset' when a
 * session or week that was at least RESET_MIN_PERCENT used runs out, else ''. The first reading
 * only sets the baseline, so a page load never switches anything.
 */
export function usageWatch() {
  let session = null, week = null; // { resetsAt, percent, tier?, calmSince?, ended? }
  function ended(win, now) {
    if (!win || !win.resetsAt || win.ended || now < win.resetsAt) return false;
    win.ended = true;
    return win.percent >= RESET_MIN_PERCENT;
  }
  function track(win, reading) {
    if (win && win.resetsAt === reading.resetsAt) { win.percent = reading.percent; return win; }
    // A new window (or the first reading): the old one is done with.
    return { resetsAt: reading.resetsAt, percent: reading.percent, ended: false };
  }
  return function check(usage, now) {
    // The time can run out between readings, so this looks before any new reading is taken in.
    const reset = ended(session, now) || ended(week, now);
    if (!usage || usage.status !== 'ok') return reset ? 'reset' : '';
    const first = !session;
    const fresh = !session || session.resetsAt !== usage.session.resetsAt;
    session = track(session, usage.session);
    week = track(week, usage.week);
    const tier = heat(usage, now);
    if (fresh) session.tier = first ? tier : 0;
    if (tier) session.calmSince = null;
    else if (session.calmSince == null) session.calmSince = now;
    else if (now - session.calmSince >= COOL_MS) session.tier = 0;
    if (reset) return 'reset';
    if (tier > session.tier) { session.tier = tier; return 'hot'; }
    return '';
  };
}

// Rain or snow this likely counts as coming.
export const WET_MIN_POP = 50;

/** Rain or snow is due within the hour and isn't falling yet. */
export function wetSoon(weather, now) {
  if (!weather || weather.status !== 'ok' || isWet(weather.current.code)) return false;
  return weather.hourly.filter(h => h.t <= now + HOUR).slice(-2)
    .some(h => h.t + HOUR > now && isWet(h.code) && h.pop >= WET_MIN_POP);
}

/**
 * check(weather, now) is true the moment rain or snow becomes due (see wetSoon), and not again
 * until it has passed or the forecast has dropped it. The first reading only sets the baseline.
 */
export function weatherWatch() {
  let was = null;
  return function check(weather, now) {
    if (!weather || weather.status !== 'ok') return false;
    const soon = wetSoon(weather, now);
    const fire = was === false && soon;
    was = soon;
    return fire;
  };
}
