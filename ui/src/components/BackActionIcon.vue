<script setup>
// The glyph after a back-action label: refresh ⟳, failed ✕, play or pause. Inter has none of them, and
// a fallback font's sits off the line and off-centre (so a turning ⟳ wobbles), so they're drawn on
// a square centred on the glyph: cap height, standing on the baseline, turning about the middle.
defineProps({ name: String, spinning: Boolean });
</script>
<template>
  <svg class="back-action-icon" :class="{ 'is-spinning': spinning }" viewBox="0 0 10 10" aria-hidden="true">
    <template v-if="name === 'refresh'"><path d="M7.06 2.05A3.6 3.6 0 1 1 2.94 2.05" fill="none" /><path d="M4.58 0.9 1.64 0.89 3.59 3.67Z" stroke="none" /></template>
    <path v-else-if="name === 'x'" d="M1 1 9 9M9 1 1 9" fill="none" />
    <path v-else-if="name === 'play'" d="M2 0.6 9.2 5 2 9.4Z" stroke="none" />
    <template v-else-if="name === 'pause'"><rect x="2" y="0" width="2" height="10" rx="0.5" stroke="none" /><rect x="6" y="0" width="2" height="10" rx="0.5" stroke="none" /></template>
  </svg>
</template>
