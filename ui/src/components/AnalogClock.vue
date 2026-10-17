<script setup>
import { computed } from 'vue';
import { CT } from '../state.js';
const props = defineProps({ now: Number, numbers: Boolean });
function point(r, turns) {
  const angle = turns * 2 * Math.PI;
  return { x: 200 + r * Math.sin(angle), y: 200 - r * Math.cos(angle) };
}
const ticks = Array.from({ length: 60 }, (_, i) => ({ a: point(176, i / 60), b: point(186, i / 60) }));
const numerals = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, ...point(144, (i + 1) / 12) }));
// Screens pass now = 0 while they're not on screen, so the clock stops redrawing. It holds its
// last time instead of drawing 0, so the hands stay put while the screen fades out.
// The hands as drawn in Figma: an outline around a filled strip, a pin above and a tail below.
const hands = [
  {
    name: 'hour',
    box: { x: 189.75, y: 60.19, width: 20.5, height: 150.06, viewBox: '0 0 25 183' },
    inner: { x: 5, y: 34, width: 16, height: 113, rx: 8 },
    paths: [
      'M13 30C19.6274 30 25 35.3726 25 42V139C25 145.627 19.6274 151 13 151C6.37258 151 1 145.627 1 139V42C1 35.3726 6.37258 30 13 30ZM13 34C8.58172 34 5 37.5817 5 42V139C5 143.418 8.58172 147 13 147C17.4183 147 21 143.418 21 139V42C21 37.5817 17.4183 34 13 34Z',
      'M11 2C11 0.895431 11.8954 0 13 0C14.1046 0 15 0.895431 15 2V30C15 31.1046 14.1046 32 13 32C11.8954 32 11 31.1046 11 30V2Z',
      'M11 149C11 147.895 11.8954 147 13 147C14.1046 147 15 147.895 15 149V161C15 162.105 14.1046 163 13 163C11.8954 163 11 162.105 11 161V149Z',
      'M25 170.5C25 177.404 19.4036 183 12.5 183C5.59644 183 0 177.404 0 170.5C0 163.596 5.59644 158 12.5 158C19.4036 158 25 163.596 25 170.5Z'
    ]
  },
  {
    name: 'minute',
    box: { x: 189.75, y: 18.37, width: 20.5, height: 191.88, viewBox: '0 0 25 234' },
    inner: { x: 9, y: 36, width: 8, height: 159, rx: 4 },
    paths: [
      'M13 30C17.4183 30 21 33.5817 21 38V193C21 197.418 17.4183 201 13 201C8.58172 201 5 197.418 5 193V38C5 33.5817 8.58172 30 13 30ZM13 36C10.7909 36 9 37.7909 9 40V191C9 193.209 10.7909 195 13 195C15.2091 195 17 193.209 17 191V40C17 37.7909 15.2091 36 13 36Z',
      'M11 2C11 0.895431 11.8954 0 13 0C14.1046 0 15 0.895431 15 2V30C15 31.1046 14.1046 32 13 32C11.8954 32 11 31.1046 11 30V2Z',
      'M11 198C11 196.895 11.8954 196 13 196C14.1046 196 15 196.895 15 198V210C15 211.105 14.1046 212 13 212C11.8954 212 11 211.105 11 210V198Z',
      'M25 221.5C25 228.404 19.4036 234 12.5 234C5.59644 234 0 228.404 0 221.5C0 214.596 5.59644 209 12.5 209C19.4036 209 25 214.596 25 221.5Z'
    ]
  }
];
let shown = 0;
const angles = computed(() => {
  if (props.now) shown = props.now;
  const p = CT.parts(shown);
  const minutes = p.minutes + p.seconds / 60;
  return { hour: ((p.hours % 12) + minutes / 60) * 30, minute: minutes * 6 };
});
</script>
<template>
  <svg class="c-face" viewBox="0 0 400 400" aria-label="Analog clock">
    <g><line v-for="(tick, i) in ticks" :key="i" :x1="tick.a.x" :y1="tick.a.y" :x2="tick.b.x" :y2="tick.b.y" class="c-tick" :class="{ hour: i % 5 === 0 }" /></g>
    <g v-if="!numbers">
      <g v-for="i in 12" :key="i" :transform="'rotate(' + (i - 1) * 30 + ' 200 200)'">
        <polygon v-if="i === 1" class="c-mark" points="184.33,43.5 215.67,43.5 200,81.08" />
        <rect v-else-if="(i - 1) % 3 === 0" class="c-mark" x="192.92" y="44.5" width="14.17" height="37.67" rx="1" />
        <circle v-else class="c-mark" cx="200" cy="55" r="10.25" />
      </g>
    </g>
    <g v-else class="c-numerals"><text v-for="n in numerals" :key="n.n" :x="n.x" :y="n.y + 11" text-anchor="middle">{{ n.n }}</text></g>
    <!-- The Figma vectors, each box keeping its built-in pivot alignment. A blurred copy sits behind
         each hand so it stands clear of the markers and the album art. -->
    <filter id="c-hand-blur" x="-100%" y="-20%" width="300%" height="140%"><feGaussianBlur stdDeviation="3" /></filter>
    <g v-for="hand in hands" :key="hand.name" :transform="'rotate(' + angles[hand.name] + ' 200 200)'">
      <g filter="url(#c-hand-blur)">
        <svg class="c-hand-shadow" v-bind="hand.box" preserveAspectRatio="none" overflow="visible">
          <rect v-bind="hand.inner" /><path v-for="(d, i) in hand.paths" :key="i" :d="d" fill-rule="evenodd" />
        </svg>
      </g>
      <svg class="c-hand" v-bind="hand.box" preserveAspectRatio="none" overflow="visible">
        <rect v-bind="hand.inner" /><path v-for="(d, i) in hand.paths" :key="i" :d="d" fill-rule="evenodd" />
      </svg>
    </g>
  </svg>
</template>
