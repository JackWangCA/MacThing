<script setup>
import { computed } from "vue";
// The timer's dial, drawn across the 480×480 stage (Figma 154:4300). A full turn is the timer's
// length: the white wedge is the time left, clockwise from 12, with a hand on its moving edge,
// and a ring of one dot per minute (per few, past an hour) that go dark as the minutes pass.
// remaining and total are ms.
// The hand and hub are always cut out of the wedge, so the background shows through them
// (Figma 202:1439). Before it starts (idle) that's all there is; once it's running, the drawn
// hand fades in over its own cut-out and the two move together.
const props = defineProps({ remaining: Number, total: Number, idle: Boolean });
function point(r, degrees) {
  const angle = (degrees * Math.PI) / 180;
  return { x: 240 + r * Math.sin(angle), y: 240 - r * Math.cos(angle) };
}
const degrees = computed(() =>
  props.total
    ? Math.max(0, Math.min(1, props.remaining / props.total)) * 360
    : 0,
);
const wedge = computed(() => {
  const end = point(145, degrees.value);
  return (
    "M240 240V95A145 145 0 " +
    (degrees.value > 180 ? 1 : 0) +
    " 1 " +
    end.x +
    " " +
    end.y +
    "Z"
  );
});
const hand = computed(() => point(145, degrees.value));
const cut = computed(() => point(151, degrees.value)); // through the disc's edge, as in Figma
// A meeting can run longer than an hour, so past 60 dots each one stands for a few minutes.
const DOT_MINUTES = [1, 5, 15, 30, 60];
const minutes = computed(() => {
  const per = (DOT_MINUTES.find((m) => props.total / (m * 60000) <= 60) || 60) * 60000;
  const n = Math.max(1, Math.round(props.total / per)),
    left = Math.ceil(props.remaining / per);
  return Array.from({ length: n }, (_, i) => ({
    ...point(175, (i * 360) / n),
    left: i < left,
  }));
});
</script>
<template>
  <svg class="t-face" viewBox="0 0 480 480" aria-label="Timer">
    <mask id="t-hand-cut">
      <rect width="480" height="480" fill="#fff" />
      <line
        x1="240"
        y1="240"
        :x2="cut.x"
        :y2="cut.y"
        stroke="#000"
        stroke-width="8"
        stroke-linecap="round"
      />
      <circle cx="240" cy="240" r="17" fill="#000" />
    </mask>
    <circle
      v-if="degrees >= 360"
      class="t-left"
      cx="240"
      cy="240"
      r="145"
      mask="url(#t-hand-cut)"
    />
    <path
      v-else-if="degrees > 0"
      class="t-left"
      :d="wedge"
      mask="url(#t-hand-cut)"
    />
    <circle
      v-for="(m, i) in minutes"
      :key="i"
      :cx="m.x"
      :cy="m.y"
      r="5"
      class="t-minute"
      :class="{ left: m.left }"
    />
    <g v-if="!idle" class="t-hand-in">
      <line class="t-hand" x1="240" y1="240" :x2="hand.x" :y2="hand.y" />
      <circle class="t-hub" cx="240" cy="240" r="17" />
    </g>
  </svg>
</template>
