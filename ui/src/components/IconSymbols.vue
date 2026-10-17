<script setup>
// Every icon on the device, from Phosphor (MIT, phosphoricons.com), bundled at build time so the
// Car Thing needs no network. Each becomes a <symbol> that the rest of the UI draws with
// <use href="#i-…">. Weather icons carry their condition's colour; the rest take currentColor.
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
import sun from '@phosphor-icons/core/assets/fill/sun-fill.svg?raw';
import moon from '@phosphor-icons/core/assets/fill/moon-fill.svg?raw';
import cloud from '@phosphor-icons/core/assets/fill/cloud-fill.svg?raw';
import fog from '@phosphor-icons/core/assets/fill/cloud-fog-fill.svg?raw';
import drizzle from '@phosphor-icons/core/assets/regular/cloud-rain.svg?raw';
import rain from '@phosphor-icons/core/assets/fill/cloud-rain-fill.svg?raw';
import snow from '@phosphor-icons/core/assets/fill/cloud-snow-fill.svg?raw';
import thunder from '@phosphor-icons/core/assets/fill/cloud-lightning-fill.svg?raw';

const ICONS = {
  'i-play': play, 'i-pause': pause, 'i-next': next, 'i-previous': previous,
  'i-heart': heart, 'i-heart-off': heartOff, 'i-note': note, 'i-timer': timer,
  'i-speaker': speaker, 'i-muted': muted, 'i-open-on-mac': openOnMac, 'i-refresh': refresh, 'i-x': x,
  'w-clear-day': sun, 'w-clear-night': moon, 
  'w-cloudy': cloud, 'w-fog': fog, 'w-drizzle': drizzle, 'w-rain': rain, 'w-snow': snow, 'w-thunder': thunder
};
const TINTS = {
  'w-clear-day': 'sun', 'w-thunder': 'sun', 'w-clear-night': 'moon',
  'w-cloudy': 'cloud', 'w-fog': 'cloud-back', 'w-snow': 'cloud', 'w-drizzle': 'rain', 'w-rain': 'rain'
};
const inner = svg => svg.replace(/^<svg[^>]*>|<\/svg>\s*$/g, '');
// Partly cloudy keeps the sun or moon its own colour: that glyph, smaller, behind a cloud.
const layer = (svg, tint, x, y, size) => `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 256 256" style="color: var(--${tint})">${inner(svg)}</svg>`;
const PARTLY = {
  'w-partly-day': layer(sun, 'sun', 0, 0, 150) + layer(cloud, 'cloud', 40, 52, 216),
  'w-partly-night': layer(moon, 'moon', 8, 4, 130) + layer(cloud, 'cloud', 40, 52, 216)
};
const symbols = [
  ...Object.entries(ICONS).map(([id, svg]) => ({ id, body: inner(svg), style: TINTS[id] ? 'color: var(--' + TINTS[id] + ')' : '' })),
  ...Object.entries(PARTLY).map(([id, body]) => ({ id, body, style: '' }))
];
</script>
<template>
  <svg width="0" height="0" style="position: absolute">
    <symbol v-for="s in symbols" :id="s.id" :key="s.id" :style="s.style" viewBox="0 0 256 256" v-html="s.body" />
  </svg>
</template>
