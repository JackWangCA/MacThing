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
 *  divided by the pace affordable for the rest of the window, like paceK. 0 without a fresh burn. */
export function burnK(w, updatedAt, now) {
  const b = w.burn, used = clamp(w.percent / 100);
  if (!b || !(b.ms > 0) || !w.resetsAt || !(now - updatedAt < BURN_FRESH_MS) || used >= 1) return 0;
  const left = Math.max(0, w.resetsAt - now);
  if (!left) return 0;
  return (b.percent / 100 / b.ms) / ((1 - used) / left);
}

const fires = k => k >= 3.5 ? '🔥🔥' : k >= 1.95 ? '🔥' : '';
/** A glanceable K label: one decimal below 2x, whole numbers from 2x with one fire, two fires
 *  from 4x, and three fires alone at the limit, so a hot label never gets longer for its decimal.
 *  Any use above zero shows at least 0.1x, so 0.0x means none. With `updatedAt`, a hot burn
 *  right now (burnK) brings its fires even while the window's pace is calm: 1.2x 🔥🔥. */
export function paceNumber(w, length, now, updatedAt) {
  const k = paceK(w, length, now);
  if (!Number.isFinite(k)) return '🔥🔥🔥';
  const rounded = Math.round(k * 10) / 10;
  const hot = [fires(k), fires(updatedAt == null ? 0 : burnK(w, updatedAt, now))].sort((a, b) => b.length - a.length)[0];
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

const PROVIDERS = { claude: ['claude'], chatgpt: ['chatgpt'], both: ['claude', 'chatgpt'], none: [] };
/** Whose usage the clock shows, a view each: Settings → Usage, Claude (the default), ChatGPT, both or none. */
export const usageProviders = state => PROVIDERS[state.settings.usageSource] || PROVIDERS.claude;
/** A provider's usage, as the Mac sent it ({status, session, week, …}). */
export const usageOf = (state, provider) => provider === 'chatgpt' ? state.chatgptUsage : state.usage;

/** Provider names stay visible even while no usage numbers are available. */
export const usageName = provider => provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
export function usageMessage(usage, provider, now) {
  const name = usageName(provider);
  const retry = usage.retryAt > now ? 'Retrying in ' + untilText(usage.retryAt, now) + '.' : 'Retrying shortly.';
  return ({
    ok: {},
    signedOut: provider === 'chatgpt'
      ? { title: 'Not signed in to ChatGPT', detail: 'Open Codex on your Mac and sign in.' }
      : { title: 'Not signed in to Claude', detail: 'Run claude auth login in Terminal on your Mac.' },
    expired: { title: 'Claude sign-in expired', detail: 'Open Claude Code on your Mac and sign in if prompted.' },
    none: { title: 'Codex isn’t on this Mac', detail: 'Install the ChatGPT app or the Codex CLI and it’ll show here.' },
    rateLimited: { title: name + ' usage delayed', detail: name + ' is limiting usage checks. ' + retry },
    error: { title: name + ' usage unavailable', detail: retry }
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
