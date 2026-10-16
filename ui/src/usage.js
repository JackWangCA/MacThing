// Claude and ChatGPT usage windows and how worried to be about each (ClaudeUsage.vue, ClockScreen.vue).
const HOUR = 3600000;
export const SESSION_MS = 5 * HOUR;
export const WEEK_MS = 7 * 24 * HOUR;

const clamp = n => Math.max(0, Math.min(1, n));
/** The share of a window's time that has gone: 0 until its first message starts it. */
export const elapsed = (resetsAt, length, now) => resetsAt ? clamp(1 - (resetsAt - now) / length) : 0;

// The level compares how fast you've been using the window with how fast you can still afford
// to: (used / time gone) ÷ (left / time left), the odds of the usage over the odds of the time.
// Early in a window what's left is nearly all of it, so this is about the burn rate, and being a
// little ahead is fine. Late in a window there's little time and little usage left, so even a
// small lead means slowing right down to make the rest last. The first 10% of the window counts
// as 10%, so one big first message doesn't read as a runaway. Under 1 you'd end the window under
// its limit even at this rate. At 97% used, always show Max regardless of pace; 100% is Over.
//   42/56 → 0.6 Good · 28/22 → 1.4 OK · 25/15 → 1.9 Ahead · 61/41 → 2.3 Ahead · 98/93 → Max
//   45/15 → 4.6 High · 70/30 → 5.4 High · 95/60 → 12.7 Severe · 90/30 → 21 Severe · 95/15 → 108 Severe
const FLOOR = 0.1, OK = 1, AHEAD = 1.5, HIGH = 3, SEVERE = 10;
/** Pace so far divided by the pace affordable for the rest of this window (K).
 * Keep the same 10%-elapsed floor as the word labels; no started window means no burn. */
export function paceK(w, length, now) {
  const used = clamp(w.percent / 100);
  if (used >= 1) return Infinity;
  if (!w.resetsAt) return 0;
  const t = Math.max(FLOOR, elapsed(w.resetsAt, length, now));
  return (used / (1 - used)) / (t / (1 - t));
}

/** A glanceable K label: a decimal below 10, whole numbers above it, infinity at the limit. */
export function paceNumber(w, length, now) {
  const k = paceK(w, length, now);
  if (!Number.isFinite(k)) return '∞x';
  const rounded = Math.round(k * 10) / 10;
  return (rounded < 10 ? rounded.toFixed(1) : String(Math.round(k))) + 'x';
}

/** 'Good', 'OK', 'Ahead', 'High', 'Severe', 'Max', or 'Over' (the limit's been hit), for a window from the Mac. */
export function paceLevel(w, length, now) {
  const used = clamp(w.percent / 100);
  if (used >= 1) return 'Over';
  if (used >= 0.97) return 'Max';
  if (!w.resetsAt) return 'Good';
  const k = paceK(w, length, now);
  return k >= SEVERE ? 'Severe' : k >= HIGH ? 'High' : k >= AHEAD ? 'Ahead' : k >= OK ? 'OK' : 'Good';
}

// Bundled Twemoji SVGs render offline even when the device has no emoji font.
const PACE_EMOJI = {
  Good: '1f44d', OK: '1f44c', Ahead: '1f44e', High: '270b',
  Severe: '1f525', Max: '1f4a5', Over: '1f6ab'
};
/** Optional image for the pace label; missing/older settings keep the words. */
export const paceImage = (level, style) => style === 'emoji' && PACE_EMOJI[level]
  ? 'images/emoji/' + PACE_EMOJI[level] + '.svg' : null;

// Under an hour the countdown steps 45, 30, 25, 20, 15, 10, then every minute to 1.
const MINUTE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 45];
/** How long until a window resets, short: under an hour the next of MINUTE_STEPS up (41 minutes
 *  is 45m, never 0m), past 45 minutes hours and days to the nearest half (1h, 1.5h, 8h, 5d). A
 *  window that hasn't started shows its full length when supplied, otherwise '–'. */
export function untilText(resetsAt, now, length) {
  if (!resetsAt) return length ? untilText(now + length, now) : '–';
  const minutes = Math.max(0, (resetsAt - now) / 60000);
  const step = MINUTE_STEPS.find(m => m >= Math.ceil(minutes));
  if (step) return Math.max(1, step) + 'm';
  const half = n => Math.round(n * 2) / 2;
  const hours = half(minutes / 60);
  return hours < 24 ? hours + 'h' : half(minutes / 1440) + 'd';
}

const PROVIDERS = { claude: ['claude'], chatgpt: ['chatgpt'], both: ['claude', 'chatgpt'], none: [] };
/** Whose usage the clock shows, a view each: Settings → Usage, Claude (the default), ChatGPT, both or none. */
export const usageProviders = state => PROVIDERS[state.settings.usageSource] || PROVIDERS.claude;
/** A provider's usage, as the Mac sent it ({status, session, week, …}). */
export const usageOf = (state, provider) => provider === 'chatgpt' ? state.chatgptUsage : state.usage;
