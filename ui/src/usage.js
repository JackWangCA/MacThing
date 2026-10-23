// Claude and ChatGPT usage windows and how worried to be about each (ClaudeUsage.vue, ClockScreen.vue).
const HOUR = 3600000;
export const SESSION_MS = 5 * HOUR;
export const WEEK_MS = 7 * 24 * HOUR;

const clamp = n => Math.max(0, Math.min(1, n));
/** The share of a window's time that has gone: 0 until its first message starts it. */
export const elapsed = (resetsAt, length, now) => resetsAt ? clamp(1 - (resetsAt - now) / length) : 0;

// Pace compares used allowance per elapsed time with remaining allowance per remaining time.
// The first 10% of a window counts as 10%, so one first message does not read as runaway burn.
const FLOOR = 0.1;
/** Pace so far divided by the pace affordable for the rest of this window (K).
 * Keep the 10%-elapsed floor; no started window means no burn. */
export function paceK(w, length, now) {
  const used = clamp(w.percent / 100);
  if (used >= 1) return Infinity;
  if (!w.resetsAt) return 0;
  const t = Math.max(FLOOR, elapsed(w.resetsAt, length, now));
  return (used / (1 - used)) / (t / (1 - t));
}

// A burn is only news while it's recent: the bridge measured it up to the reading at updatedAt.
const BURN_FRESH_MS = 20 * 60 * 1000;
/** The pace right now: the window's use over its last 10–20 minutes (w.burn, from the bridge)
 *  divided by the pace affordable for the rest of the window, like paceK. null without a fresh burn. */
export function burnK(w, updatedAt, now) {
  const b = w.burn, used = clamp(w.percent / 100);
  if (!b || !(b.ms > 0) || !w.resetsAt || !(now - updatedAt < BURN_FRESH_MS) || used >= 1) return null;
  const left = Math.max(0, w.resetsAt - now);
  if (!left) return null;
  return (b.percent / 100 / b.ms) / ((1 - used) / left);
}

/** How hot a window is: from the pace at the current rate (the fresh burn when the bridge has one,
 *  else the average so far). Either pace is the time left until reset divided by the time until
 *  the allowance runs out at that rate, so above 1x you'd be locked out before the reset, and
 *  above 2x the lockout would be longer than the time you'd have left to work. Rounded like the
 *  label, so 1.0x is calm and anything that reads 2x has both fires. */
export function fires(k) {
  const rounded = Math.round(k * 10) / 10;
  return rounded >= 2 ? '🔥🔥' : rounded > 1 ? '🔥' : '';
}

/** A glanceable K label: one decimal below 2x and whole numbers from 2x, so a hot label never
 *  gets longer for its decimal, then its fires; a skull alone at the limit. Any use above zero
 *  shows at least 0.1x, so 0.0x means none. With `updatedAt` (the session), the fires follow the
 *  burn right now when there is one: a 1.0x session suddenly burning at 4x reads 1.0x 🔥🔥, and
 *  a 3x session that has stopped reads 3x. `maxFires` caps them: the week takes none, since its
 *  average runs hot on weekdays and cools over the weekend, so only its 💀 means anything. */
export function paceNumber(w, length, now, { updatedAt, maxFires = 2 } = {}) {
  const k = paceK(w, length, now);
  if (!Number.isFinite(k)) return '💀';
  const rounded = Math.round(k * 10) / 10;
  const recent = updatedAt == null ? null : burnK(w, updatedAt, now);
  const hot = fires(recent ?? k).slice(0, maxFires * 2);
  const label = k > 0 && rounded < 0.1 ? '0.1x' : rounded < 2 ? rounded.toFixed(1) + 'x' : Math.round(k) + 'x';
  return hot ? label + ' ' + hot : label;
}

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

const PROVIDERS = { bottlerocket: ['bottlerocket'], claude: ['bottlerocket'], chatgpt: ['chatgpt'], both: ['bottlerocket', 'chatgpt'], none: [] };
/** Whose usage the clock shows, a view each: Settings → Usage, Bottlerocket (the default), ChatGPT, both or none. */
export const usageProviders = state => PROVIDERS[state.settings.usageSource] || PROVIDERS.bottlerocket;
/** A provider's usage, as the Mac sent it ({status, session, week, …} or Bottlerocket {spent, limit, percent}). */
export const usageOf = (state, provider) => provider === 'chatgpt' ? state.chatgptUsage : state.usage;

/** Dollars the way the tokens site prints them: $1,234.56. Grouped by hand because the device's
 *  Chromium ignores toLocaleString's options, and a spend summed over dozens of rows arrives as
 *  382.39000000000004 — every one of those digits would land on the screen. */
export function moneyText(n) {
  if (!Number.isFinite(n)) return '–';
  const [whole, cents] = Math.abs(n).toFixed(2).split('.');
  return (n < 0 ? '-' : '') + '$' + grouped(whole) + '.' + cents;
}
/** The same with the cents dropped, for the rail's big slot: $12,345.67 is wider than the rail
 *  at any size that still reads as the headline, and $12,346 is not. */
export function moneyRound(n) {
  if (!Number.isFinite(n)) return '–';
  return (n < 0 ? '-' : '') + '$' + grouped(String(Math.round(Math.abs(n))));
}
const grouped = whole => whole.replace(/\B(?=(\d{3})+$)/g, ',');

/** Provider names stay visible even while no usage numbers are available. */
export const usageName = provider => provider === 'chatgpt' ? 'ChatGPT' : 'Bottlerocket';
export function usageMessage(usage, provider, now) {
  const name = usageName(provider);
  const retry = usage.retryAt > now ? 'Retrying in ' + untilText(usage.retryAt, now) + '.' : 'Retrying shortly.';
  // Both token states are fixed in the same place, so both say where that is.
  const onTheMac = 'Add a Bottlerocket API token in Settings → Usage on your Mac.';
  return ({
    ok: {},
    signedOut: { title: 'Not signed in to ChatGPT', detail: 'Open Codex on your Mac and sign in.' },
    noToken: { title: 'No Bottlerocket token', detail: onTheMac },
    badToken: { title: 'Bottlerocket token refused', detail: (usage.detail || '') + ' ' + onTheMac },
    none: provider === 'chatgpt'
      ? { title: 'Codex isn’t on this Mac', detail: 'Install the ChatGPT app or the Codex CLI and it’ll show here.' }
      : { title: 'No Bottlerocket tokens', detail: 'This account has no personal tokens to add up.' },
    rateLimited: { title: name + ' usage delayed', detail: name + ' is limiting usage checks. ' + retry },
    // A sign-in that the account or app registration refuses says why; everything else just retries.
    error: { title: name + ' usage unavailable', detail: usage.detail ? usage.detail + ' ' + retry : retry }
  })[usage.status] || { title: 'Getting ' + name + ' usage…' };
}
export function usageAge(updatedAt, now) {
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60000));
  return minutes < 1 ? 'just now' : minutes < 60 ? minutes + 'm ago' : Math.floor(minutes / 60) + 'h ago';
}

/** How old the numbers are ('12m'), once a refresh has been missed; '' during normal five-minute polling. */
export function usageStaleAge(usage, now) {
  return usage.status === 'ok' && Number.isFinite(usage.updatedAt) && now - usage.updatedAt >= 10 * 60000
    ? usageAge(usage.updatedAt, now).replace(/ ago$/, '') : '';
}
export function usageUpdatedText(usage, now) {
  const age = usageStaleAge(usage, now);
  return age ? age + ' ⟳' : '';
}
