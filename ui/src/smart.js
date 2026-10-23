import { watch } from 'vue';
import { state, CT } from './state.js';
import { timer } from './timer.js';
import { usageProviders } from './usage.js';
import { usageWatch, weatherWatch } from './smart-triggers.js';

// Settings → Smart switching: the screen moves by itself when something is worth a look.
//   Claude or ChatGPT usage speeds up (its pace reaches 2x, 4x or the limit) or comes back (a
//   session or week that was well used resets): that usage, on the clock screen.
//   Rain or snow is due within the hour: the weather's forecast.
// Taken off Now Playing, it goes back there on the first song change after HOLD_MS, so the screen
// it put up stays at least that long but not for as long as the music goes on. Moving the screen,
// or pressing a top button, settles it where it is. (Meetings have their own alert, so the
// calendar never needs this.)
const HOLD_MS = 30000;
const QUIET_MS = 10000; // after a button or the knob, wait this long: someone is using the device
const PENDING_MS = 3 * 60000; // something in the way for longer than this: let the moment go

const usageChecks = { claude: usageWatch(), chatgpt: usageWatch() };
const weatherCheck = weatherWatch();
let pending = null; // { show: () => void, until }
let placed = ''; // the screen this put up, until someone moves off it
let returnTo = ''; // 'nowplaying' when that's where this took the screen from
let holdUntil = 0;
let lastInput = -Infinity;

const enabled = () => !!state.settings.smartSwitch;
const timerUp = () => timer.status === 'running' || timer.status === 'paused' || timer.status === 'done';
function busy() {
  return state.offline || state.asleep || !!CT.lockedTo || state.current === 'settings'
    || (CT.modalOpen && CT.modalOpen()) || timerUp() || performance.now() - lastInput < QUIET_MS;
}

function want(show) {
  if (enabled()) pending = { show, until: performance.now() + PENDING_MS };
}

function go(show) {
  const from = state.current;
  show();
  if (state.current === from) return; // already there, or the screen wouldn't move
  if (from === 'nowplaying') returnTo = 'nowplaying';
  placed = state.current;
  holdUntil = performance.now() + HOLD_MS;
}

CT.onSecond(now => {
  // Every watcher looks every second, on or off, so turning the setting on doesn't treat
  // whatever has built up meanwhile as new.
  const shown = usageProviders(state);
  Object.keys(usageChecks).forEach(provider => {
    const usage = provider === 'chatgpt' ? state.chatgptUsage : state.usage;
    const event = usageChecks[provider](usage, now);
    if (event && shown.includes(provider)) want(() => CT.showUsage && CT.showUsage(provider));
  });
  if (weatherCheck(state.weather, now)) want(() => CT.showForecast && CT.showForecast());
  if (!pending) return;
  if (!enabled() || performance.now() > pending.until) pending = null;
  else if (!busy()) { const show = pending.show; pending = null; go(show); }
});

function settle() { placed = ''; returnTo = ''; }
// Vue runs this after go() has noted the screen it put up, so only someone else's move settles it.
watch(() => state.current, current => { if (current !== placed) settle(); });
watch(enabled, on => { if (!on) { settle(); pending = null; } });
CT.on('input', key => {
  lastInput = performance.now();
  if (/^[1-4m]$/.test(key)) settle(); // a top or settings button: choosing what's on screen
});

const trackOf = np => np.active ? np.title + '\n' + np.artist + '\n' + np.album : '';
watch(() => trackOf(state.np), track => {
  if (!track || !returnTo || state.current !== placed || performance.now() < holdUntil) return;
  if (CT.lockedTo || (CT.modalOpen && CT.modalOpen())) return;
  CT.show(returnTo);
  settle();
});
