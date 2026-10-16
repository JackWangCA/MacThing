import { reactive, ref, computed, watch } from 'vue';
import { initializeRuntime } from '../js/core.js';

export const state = reactive({
  // screenSwitch: how the current screen is coming in ('fade', 'next', 'previous'), until it has (core.js).
  current: 'nowplaying', leaving: '', screenSwitch: 'fade', offline: true, asleep: false, light: false,
  settings: { theme: 'dark', units: 'F', clock24h: false, clockFace: 'analog', meetingAlert: 0, meetingTimer: false, sleepWithMac: true, location: { mode: 'auto' } },
  now: Date.now(), np: { active: false }, npAt: 0, artwork: null,
  weather: { status: 'loading' }, calendar: { status: 'loading' },
  volume: 0, volumeUnsupported: false, volumeNote: '', showVolume: false,
  flash: { icon: 'play', color: '', key: 0 }, flashing: false, toast: ''
});
export const CT = initializeRuntime(state);
// The art on screen only changes once its replacement is decoded, and a track that arrives
// without art keeps the old art for a moment: players often send the new title first and its art
// a beat later, and dropping to nothing in between flashes the stage and the ambient background.
const ART_GRACE_MS = 1500;
const shownArt = ref('');
const shownBlur = ref(''); // the album art background, blurred on the Mac (empty: the device blurs the cover)
const shownTint = ref(null); // how strong a tint that background needs in each theme, measured on the Mac
let artClear, artLoad = 0;
function preload(url) {
  return new Promise(resolve => {
    if (!url) return resolve();
    const img = new Image();
    // decode() can stay pending while the page is hidden, so it only gets a moment to finish.
    img.onload = () => Promise.race([img.decode && img.decode().catch(() => {}), new Promise(r => setTimeout(r, 250))]).then(resolve);
    img.onerror = resolve;
    img.src = url;
  });
}
function showArt(art) {
  const seq = ++artLoad;
  Promise.all([preload(art.dataUrl), preload(art.blurUrl)]).then(() => {
    if (seq !== artLoad) return;
    shownArt.value = art.dataUrl;
    shownBlur.value = art.blurUrl || '';
    shownTint.value = art.blurUrl && art.tint || null;
  });
}
watch(() => [state.np.artworkKey, state.artwork], () => {
  clearTimeout(artClear);
  if (!state.np.artworkKey) {
    artLoad++;
    artClear = setTimeout(() => { shownArt.value = ''; shownBlur.value = ''; shownTint.value = null; }, shownArt.value ? ART_GRACE_MS : 0);
  } else if (state.artwork && state.artwork.key === state.np.artworkKey && state.artwork.dataUrl !== shownArt.value) {
    showArt(state.artwork);
  }
});
export const artworkUrl = computed(() => state.np.active ? shownArt.value : '');
// For the album art background: the Mac's blurred image when it sent one, else the cover to blur here.
export const ambientUrl = computed(() => state.np.active ? shownBlur.value || shownArt.value : '');
// The tint over the album art background, black under the dark theme's white text and white under
// the light theme's dark text. Each theme's usual strength, or more when the Mac measured the art
// as too bright (dark) or too dark (light) for the text to stay readable over it.
const AMBIENT_TINT = { dark: 0.3, light: 0.4 };
export const ambientTint = computed(() => {
  const theme = state.light ? 'light' : 'dark';
  const alpha = Math.min(0.6, Math.max(AMBIENT_TINT[theme], shownTint.value && shownTint.value[theme] || 0));
  return (state.light ? 'rgba(255,255,255,' : 'rgba(0,0,0,') + alpha.toFixed(2) + ')';
});
export const ambientPreBlurred = computed(() => !!shownBlur.value);
// The track has art, even if it's still loading (as it is just after the page mounts). Backgrounds
// follow this rather than artworkUrl, so they're already the art's while it loads and it fades
// in, instead of the no-art greys showing first and snapping over.
export const hasArt = computed(() => !!(state.np.active && (shownArt.value || state.np.artworkKey)));
CT.onSecond(now => { state.now = now; });
CT.on('tick', () => { state.now = CT.now(); });
CT.on('nowPlaying', msg => { state.np = msg.np; state.npAt = performance.now(); });
CT.on('artwork', msg => { state.artwork = msg; });
CT.on('weather', msg => { state.weather = msg.weather; });
CT.on('calendar', msg => { state.calendar = msg.calendar; });

export function elapsed() {
  const np = state.np;
  if (!np.active || np.elapsed == null) return 0;
  const value = np.elapsed + (performance.now() - state.npAt) / 1000 * (np.rate || 0);
  return Math.max(0, np.duration ? Math.min(np.duration, value) : value);
}
export function durationText(seconds) {
  const n = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), s = String(n % 60).padStart(2, '0');
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
}
CT.on('command', action => {
  const np = state.np;
  if (action === 'playpause') {
    if (np.active) {
      np.elapsed = elapsed();
      state.npAt = performance.now();
      np.playing = !np.playing;
      np.rate = np.playing ? 1 : 0;
    }
    if (state.current !== 'nowplaying' || !np.active) CT.flash(!np.active || np.playing ? 'play' : 'pause');
  } else if (action === 'next' || action === 'previous') CT.flash(action);
});
CT.on('favorite', msg => {
  CT.flash(msg.favorited ? 'heart' : 'heart-off');
  CT.toast(msg.favorited ? 'Added to Favorites' : 'Removed from Favorites');
});
