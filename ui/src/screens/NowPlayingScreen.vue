<script setup>
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { state, CT, elapsed, durationText, artworkUrl, hasArt, idleCover } from '../state.js';
import LeftRail from '../components/LeftRail.vue';
import ScreenStage from '../components/ScreenStage.vue';
import UiProgress from '../components/UiProgress.vue';
import Artwork from '../components/Artwork.vue';
const root = ref(null), rail = ref(null);
const np = computed(() => state.np);
const album = computed(() => !np.value.active ? '' : np.value.album || (np.value.kind !== 'music' && np.value.source ? np.value.source.name : '') || '');
// Nothing playing: the perpetual calendar. The rail shows the month, the date and the day, with the
// time where the progress bar goes, and today's cover takes the album art's place (state.js).
// Read to the minute, so the screen isn't redrawn every second for text that changes once a minute.
const minute = computed(() => Math.floor(state.now / 60000));
const parts = computed(() => CT.parts(minute.value * 60000));
const IDLE = computed(() => ({ eyebrow: CT.MONTHS[parts.value.month], title: String(parts.value.date), subtitle: CT.DAYS[parts.value.day] }));
const time = computed(() => CT.clockText(parts.value).time);
const idleCoverUrl = computed(() => idleCover.value ? idleCover.value.dataUrl : '');
const stageArt = computed(() => artworkUrl.value || idleCoverUrl.value);
const icon = computed(() => np.value.active && np.value.source ? np.value.source.icon : '');
// { inLibrary, favorited } for a playing Apple Music song, once the Mac has asked Music; null for
// anything else. Both marks stay drawn, lit or faint, so the back button's toggles read at a glance.
const marks = computed(() => np.value.active && np.value.marks || null);
// The row is drawn, blank, from the moment the Mac says this track can be marked — Music takes a
// few hundred milliseconds to say how. Holding the height is what stops the title being fitted
// twice, big then small, every time a song changes.
const markable = computed(() => Boolean(np.value.active && np.value.markable));
const fraction = ref(0);
const played = ref(0); // how far in, counted up live beside the bar (the length is the bar's job)
function updateProgress() {
  played.value = elapsed();
  fraction.value = np.value.duration ? played.value / np.value.duration : 0;
}
// The time beside the bar, and the longest it can get on this track — drawn invisibly to hold the
// slot open, so the bar keeps one width while the number counts up. Nothing playing: the 0:00
// placeholder sizes itself.
const timeNow = computed(() => np.value.duration ? durationText(played.value) : np.value.active ? '' : '0:00');
const timeMax = computed(() => np.value.duration ? durationText(np.value.duration) : np.value.active ? '' : '0:00');
// Measured typography is the only imperative layout here. These inline values
// deliberately override .np-title's fallback font-size/line-height.

/** Width of the title's widest word at the size currently set on it. */
function widestWord(t, words) {
  const probe = document.createElement('span');
  // Absolute and hidden: it measures inside the title's own font without joining its lines.
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:0;top:0';
  t.appendChild(probe);
  let widest = 0;
  for (const word of words) {
    probe.textContent = word;
    widest = Math.max(widest, probe.offsetWidth);
  }
  t.removeChild(probe);
  return widest;
}

function fitTitle() {
  const t = rail.value && rail.value.titleElement;
  if (!t || !root.value) return;
  const content = root.value.querySelector('.left-rail-content');
  t.style.webkitLineClamp = '';
  t.classList.remove('break-word');
  if (!np.value.active) { t.style.fontSize = ''; t.style.lineHeight = ''; return; } // the date keeps its own size
  // The browser can wrap after a hyphen or en dash, so "Three-Legged" is measured as "Three-"
  // and "Legged" rather than as one word.
  const words = (t.textContent || '').match(/[^\s\-‐–]+[\-‐–]*|[\-‐–]+/g) || [];
  const scale = [[48, 64], [40, 56], [28, 36]];
  // A title is sized down until it fits the rail's height *and* its longest word fits the
  // rail's width: splitting a word across lines reads worse than a smaller title.
  for (const [size, line] of scale) {
    t.style.fontSize = size + 'px'; t.style.lineHeight = line + 'px';
    const last = rail.value.subtitleElement || t;
    if (widestWord(t, words) <= t.clientWidth
      && last.getBoundingClientRect().bottom <= content.getBoundingClientRect().bottom
      && t.offsetHeight <= line * 5.01) return;
  }
  // Nothing fit: keep the smallest size, and only now allow a word to break.
  if (widestWord(t, words) > t.clientWidth) t.classList.add('break-word');
  const last = rail.value.subtitleElement || t;
  const overflow = Math.max(0, last.getBoundingClientRect().bottom - content.getBoundingClientRect().bottom);
  t.style.webkitLineClamp = String(Math.max(1, Math.min(5, Math.floor((t.offsetHeight - overflow) / 36))));
}
// Separate sources, so the title is only measured again when one of them changes, not whenever a
// Now Playing message (every 15s, and with each play/pause) replaces state.np.
// markable, not marks: the row's height is what the title is measured against, and that is
// settled when the track arrives. The marks themselves only light glyphs already on screen.
watch([() => np.value.active, () => np.value.artist, () => np.value.title, album, () => state.current, markable], () => nextTick(fitTitle));
watch(() => [state.np, state.npAt], updateProgress);
const screen = CT.screen('nowplaying');
screen.show = () => { updateProgress(); nextTick(fitTitle); };
let timer;
onMounted(() => {
  fitTitle();
  timer = setInterval(() => { if (state.current === 'nowplaying' && !state.asleep) updateProgress(); }, 250);
  if (document.fonts) document.fonts.ready.then(fitTitle);
});
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <section ref="root" id="screen-nowplaying" class="screen fill flex" :class="{ active: state.current === 'nowplaying', leaving: state.leaving === 'nowplaying', idle: !np.active, 'idle-cover': !!idleCoverUrl, paused: np.active && !np.playing, 'no-duration': np.active && !np.duration }">
    <LeftRail ref="rail" :variant="np.active ? 'media' : 'date'" :eyebrow="np.active ? np.artist : IDLE.eyebrow" :title="np.active ? np.title : IDLE.title" :subtitle="np.active ? album : IDLE.subtitle" :muted-subtitle="np.active && !np.album">
      <template #lower>
        <div v-if="markable" class="np-marks flex items-center gap-12" :class="{ waiting: !marks }">
          <svg :class="{ on: marks && marks.inLibrary }"><use href="#i-check" /></svg>
          <svg :class="{ on: marks && marks.favorited }"><use href="#i-heart" /></svg>
        </div>
        <div v-if="np.active" class="np-progress flex items-center gap-8 primary"><UiProgress :value="fraction" /><span class="np-duration flex-none regular"><span class="np-duration-max">{{ timeMax }}</span><span class="np-duration-now">{{ timeNow }}</span></span></div>
        <span v-else class="np-time">{{ time }}</span>
      </template>
    </LeftRail>
    <ScreenStage :class="{ 'bg-panel': hasArt || idleCoverUrl }"><!-- behind art: one continuous background, so nothing is left as a square when the art fades -->
      <Artwork :url="stageArt" />
      <div v-if="!hasArt && !idleCoverUrl" class="np-placeholder fill flex center"><svg><use href="#i-note" /></svg></div><!-- the cover's stand-in, idle or for a track without art -->
      <div class="paused-glyph disc fill flex center" :style="{ color: state.flashing ? state.flash.color : '' }"><svg><use :href="'#i-' + (state.flashing ? state.flash.icon : 'pause')" /></svg></div><!-- a flash here swaps its icon into this badge for a moment, in place of a second disc -->
      <img v-if="icon" class="badge" :src="icon" alt="" />
    </ScreenStage>
  </section>
</template>
