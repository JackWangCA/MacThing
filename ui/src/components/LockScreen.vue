<script setup>
import { computed } from 'vue';
import { state, CT } from '../state.js';
import AnalogClock from './AnalogClock.vue';
// Settings → When Mac is locked, set to Lock sheet: a sheet over everything while the Mac's lock
// screen is up. The bridge decides when (main.js lockedScreen) and says so with a lock message;
// state.lock is 'lock', 'lockTrack', or null.
//
// It covers rather than navigates, so unlocking puts back exactly the screen you left, mid-fade
// and all. What it shows is deliberately thin: the time, the date, and a padlock. The screens
// underneath carry meetings, reminders and track titles, and a locked Mac on a desk is precisely
// when nobody is sitting in front of them. 'lockTrack' adds the track back, because wanting to see
// what's on while you're away from the desk is a fair thing to want — it is opt-in for that reason.
//
// Settings → Lock clock face picks the face. 'match' follows Settings → Clock face, so by
// default the device looks like itself rather than like a different product for the hours it
// spends locked; the rest override it, since the two screens are read from different distances
// and a face that suits one need not suit the other.
const face = computed(() => {
  const chosen = state.settings.lockFace;
  return !chosen || chosen === 'match' ? state.settings.clockFace : chosen;
});
const showing = computed(() => !!state.lock);
const time = computed(() => CT.clockText(CT.parts(state.now)));
const date = computed(() => {
  const p = CT.parts(state.now);
  return CT.DAYS[p.day] + ', ' + p.date + ' ' + CT.MONTHS[p.month];
});
// Only with 'lockTrack', and only when something actually is: an empty line would read as a fault.
const track = computed(() => {
  if (state.lock !== 'lockTrack' || !state.np.active) return null;
  return { title: state.np.title || '', artist: state.np.artist || '' };
});
</script>
<template>
  <div class="lock-screen fill flex-col center" :class="{ on: showing }">
    <div class="lock-badge flex center"><svg><use href="#i-lock" /></svg></div>
    <!-- now = 0 parks the hands while the sheet is down, the way the screens do when they're off. -->
    <AnalogClock v-if="face !== 'digital'" class="lock-analog" :numbers="face === 'numbers'" :now="showing ? state.now : 0" />
    <div v-else class="lock-time tabular semibold">{{ time.time }}<span v-if="time.ampm" class="lock-ampm">{{ time.ampm }}</span></div>
    <div class="lock-date font-small weight-light muted">{{ date }}</div>
    <div v-if="track" class="lock-track flex center">
      <svg class="lock-note"><use href="#i-note" /></svg>
      <div class="lock-track-text truncate"><span class="lock-title">{{ track.title }}</span><span v-if="track.artist" class="lock-artist muted"> — {{ track.artist }}</span></div>
    </div>
  </div>
</template>
