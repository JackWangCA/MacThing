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

/** A glanceable K label: a decimal below 10, whole numbers above it, three fires at the limit. */
export function paceNumber(w, length, now) {
  const k = paceK(w, length, now);
  if (!Number.isFinite(k)) return '🔥🔥🔥';
  const rounded = Math.round(k * 10) / 10;
  return (rounded < 10 ? rounded.toFixed(1) : String(Math.round(k))) + 'x';
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
    signedOut: { title: 'Not signed in to Claude', detail: 'Run claude auth login in Terminal on your Mac.' },
    expired: { title: 'Claude sign-in expired', detail: 'Open Claude Code on your Mac and sign in if prompted.' },
    none: { title: 'No ChatGPT usage yet', detail: 'Use Codex on this Mac and it’ll show here.' },
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
