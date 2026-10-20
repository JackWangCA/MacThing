<script setup>
import { computed, ref, watch } from 'vue';
import { state, hasArt, ambientUrl, ambientPreBlurred, ambientTint } from './state.js';
import Artwork from './components/Artwork.vue';
import IconSymbols from './components/IconSymbols.vue';
import UiProgress from './components/UiProgress.vue';
import NowPlayingScreen from './screens/NowPlayingScreen.vue';
import CalendarScreen from './screens/CalendarScreen.vue';
import WeatherScreen from './screens/WeatherScreen.vue';
import ClockScreen from './screens/ClockScreen.vue';
import SettingsScreen from './screens/SettingsScreen.vue';
import MeetingAlert from './components/MeetingAlert.vue';
// The paused badge on Now Playing shows flashes itself (it swaps its icon), so the flash's own disc stays hidden.
const pausedBadge = computed(() => state.current === 'nowplaying' && state.np.active && !state.np.playing);
// Which of the two showed *this* flash, settled as it fires rather than read live. Read live, it
// changed the moment playback resumed: the badge stopped claiming the flash, the disc's class went
// back on, and the CSS animation ran again — replaying whatever last flashed, usually the plus
// from adding to the library, as though the button had just been pressed. Sync, so the answer is
// taken before the render that the new key triggers.
const badgeTookFlash = ref(false);
watch(() => state.flash.key, () => { badgeTookFlash.value = pausedBadge.value; }, { flush: 'sync' });
const ambient = computed(() => !!(state.settings.artBackground && hasArt.value));
const NOTCHED = ['nowplaying', 'calendar', 'weather', 'clock']; // left to right, as the top buttons run
// Settings has no top button, so the notch stays under the last page's while it fades out.
const notchAt = ref(Math.max(0, NOTCHED.indexOf(state.current)));
watch(() => state.current, current => { if (NOTCHED.includes(current)) notchAt.value = NOTCHED.indexOf(current); });
</script>
<template>
  <IconSymbols />
  <div id="app" :data-screen="state.current" :class="{ offline: state.offline, asleep: state.asleep, light: state.light, 'ambient-on': ambient, 'show-volume': state.showVolume, 'volume-unsupported': state.volumeUnsupported }">
    <div v-if="ambient" class="ambient fill" :class="{ 'pre-blurred': ambientPreBlurred }"><Artwork :url="ambientUrl" :tint="ambientTint" /></div>
    <div class="screens fill" :data-switch="state.screenSwitch || null"><NowPlayingScreen /><CalendarScreen /><WeatherScreen /><ClockScreen /><SettingsScreen /></div>
    <div class="page-notch" :class="{ on: NOTCHED.includes(state.current) }" :style="{ transform: 'translateX(' + notchAt * 201 + 'px)' }" />
    <MeetingAlert />
    <div class="volume-hud">
      <UiProgress v-show="!state.volumeUnsupported" :value="state.volume" />
      <div v-show="state.volumeUnsupported" class="vol-note font-small weight-light truncate">{{ state.volumeNote }}</div>
    </div>
    <div :key="state.flash.key" class="flash disc flex center" :class="{ on: state.flash.key > 0 && !badgeTookFlash }" :style="{ color: state.flash.color }"><svg><use :href="'#i-' + state.flash.icon" /></svg></div>
    <div class="toast" :class="{ on: !!state.toast }">{{ state.toast }}</div>
    <div class="offline-screen fill flex-col center"><div class="pulse" /><div class="mt-28 font-medium semibold">Waiting for your Mac</div><div class="mt-10 font-small weight-light muted">Connect by USB and start the bridge</div></div>
  </div>
</template>
