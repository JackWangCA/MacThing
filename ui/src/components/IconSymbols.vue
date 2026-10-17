<script setup>
// The UI icons, from Phosphor (MIT, phosphoricons.com), bundled at build time so the Car Thing
// needs no network. Each becomes a <symbol> that the rest of the UI draws with <use href="#i-…">,
// in currentColor. The weather icons are drawn here, full colour, from shared sun, moon and cloud shapes.
import play from '@phosphor-icons/core/assets/fill/play-fill.svg?raw';
import pause from '@phosphor-icons/core/assets/fill/pause-fill.svg?raw';
import next from '@phosphor-icons/core/assets/fill/skip-forward-fill.svg?raw';
import previous from '@phosphor-icons/core/assets/fill/skip-back-fill.svg?raw';
import heart from '@phosphor-icons/core/assets/fill/heart-fill.svg?raw';
import heartOff from '@phosphor-icons/core/assets/bold/heart-bold.svg?raw';
import note from '@phosphor-icons/core/assets/fill/music-notes-fill.svg?raw';
import timer from '@phosphor-icons/core/assets/fill/timer-fill.svg?raw';
import speaker from '@phosphor-icons/core/assets/fill/speaker-high-fill.svg?raw';
import muted from '@phosphor-icons/core/assets/fill/speaker-x-fill.svg?raw';
import openOnMac from '@phosphor-icons/core/assets/bold/sign-out-bold.svg?raw';
import refresh from '@phosphor-icons/core/assets/bold/arrow-clockwise-bold.svg?raw';
import x from '@phosphor-icons/core/assets/bold/x-bold.svg?raw';

const ICONS = {
  'i-play': play, 'i-pause': pause, 'i-next': next, 'i-previous': previous,
  'i-heart': heart, 'i-heart-off': heartOff, 'i-note': note, 'i-timer': timer,
  'i-speaker': speaker, 'i-muted': muted, 'i-open-on-mac': openOnMac, 'i-refresh': refresh, 'i-x': x
};
const inner = svg => svg.replace(/^<svg[^>]*>|<\/svg>\s*$/g, '');
const symbols = Object.entries(ICONS).map(([id, svg]) => ({ id, body: inner(svg) }));
</script>
<template>
  <svg width="0" height="0" style="position: absolute">
    <symbol v-for="s in symbols" :id="s.id" :key="s.id" viewBox="0 0 256 256" v-html="s.body" />
    <!-- Weather icons (64×64, full colour) -->
    <symbol id="w-cloud-shape" viewBox="0 0 64 64">
      <circle cx="24" cy="40" r="10" />
      <circle cx="36" cy="33" r="13" />
      <circle cx="47" cy="41" r="9" />
      <rect x="24" y="40" width="23" height="10" />
    </symbol>
    <symbol id="w-sun-shape" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="12" style="fill: var(--sun)" />
      <g style="stroke: var(--sun)" stroke-width="4" stroke-linecap="round">
        <path
          d="M32 6v6M32 52v6M6 32h6M52 32h6M13.6 13.6l4.2 4.2M46.2 46.2l4.2 4.2M13.6 50.4l4.2-4.2M46.2 17.8l4.2-4.2"
        />
      </g>
    </symbol>
    <symbol id="w-moon-shape" viewBox="0 0 64 64">
      <path
        d="M40 10a22 22 0 1 0 14 34A18 18 0 0 1 40 10z"
        style="fill: var(--moon)"
      />
    </symbol>
    <symbol id="w-clear-day" viewBox="0 0 64 64">
      <use href="#w-sun-shape" />
    </symbol>
    <symbol id="w-clear-night" viewBox="0 0 64 64">
      <use href="#w-moon-shape" />
    </symbol>
    <symbol id="w-partly-day" viewBox="0 0 64 64">
      <use href="#w-sun-shape" x="-9" y="-9" width="58" height="58" />
      <use href="#w-cloud-shape" y="4" style="fill: var(--cloud)" />
    </symbol>
    <symbol id="w-partly-night" viewBox="0 0 64 64">
      <use href="#w-moon-shape" x="-8" y="-8" width="52" height="52" />
      <use href="#w-cloud-shape" y="4" style="fill: var(--cloud)" />
    </symbol>
    <symbol id="w-cloudy" viewBox="0 0 64 64">
      <use
        href="#w-cloud-shape"
        x="-8"
        y="-9"
        style="fill: var(--cloud-back)"
      />
      <use href="#w-cloud-shape" x="4" y="2" style="fill: var(--cloud)" />
    </symbol>
    <symbol id="w-fog" viewBox="0 0 64 64">
      <use href="#w-cloud-shape" y="-10" style="fill: var(--cloud-back)" />
      <g style="stroke: var(--cloud)" stroke-width="4" stroke-linecap="round">
        <path d="M14 48h36M20 56h26" />
      </g>
    </symbol>
    <symbol id="w-drizzle" viewBox="0 0 64 64">
      <use href="#w-cloud-shape" y="-10" style="fill: var(--cloud)" />
      <g style="stroke: var(--rain)" stroke-width="4" stroke-linecap="round">
        <path d="M24 48v4M34 50v4M44 48v4" />
      </g>
    </symbol>
    <symbol id="w-rain" viewBox="0 0 64 64">
      <use href="#w-cloud-shape" y="-10" style="fill: var(--cloud)" />
      <g style="stroke: var(--rain)" stroke-width="4" stroke-linecap="round">
        <path d="M25 46l-3 10M35 46l-3 10M45 46l-3 10" />
      </g>
    </symbol>
    <symbol id="w-snow" viewBox="0 0 64 64">
      <use href="#w-cloud-shape" y="-10" style="fill: var(--cloud)" />
      <g style="fill: var(--cloud-back)">
        <circle cx="24" cy="50" r="3" />
        <circle cx="34" cy="55" r="3" />
        <circle cx="44" cy="50" r="3" />
      </g>
    </symbol>
    <symbol id="w-thunder" viewBox="0 0 64 64">
      <use href="#w-cloud-shape" y="-10" style="fill: var(--cloud-back)" />
      <path d="M35 40l-9 12h7l-4 10 11-14h-7l4-8z" style="fill: var(--sun)" />
    </symbol>
  </svg>
</template>
