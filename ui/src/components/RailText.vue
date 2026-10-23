<script setup>
import { computed } from 'vue';
import { state } from '../state.js';
const props = defineProps({
  text: { type: [String, Number], default: '' },
  italicSuffix: { type: String, default: '' }
});
// A trailing run of 🔥 or 💀 (how hot a usage pace is, see usage.js) is drawn as images after the
// text: the Mac's Apple emoji once it has sent them, else the bundled Twemoji fire. Without the
// Mac's skull, the limit shows the three bundled fires it used to.
const FIRE = 'images/emoji/1f525.svg';
const parts = computed(() => {
  const [, body, run] = String(props.text).match(/^(.*?)\s*((?:🔥|💀)*)$/su);
  const icons = [...run];
  const images = icons.flatMap(e => state.emoji[e] ? [state.emoji[e]] : e === '💀' ? [FIRE, FIRE, FIRE] : [FIRE]);
  return { body, icons: icons.join(''), images, skull: icons.length === 1 && icons[0] === '💀' && images.length === 1 };
});
const hasItalicSuffix = computed(() => props.italicSuffix && parts.value.body.endsWith(props.italicSuffix));
</script>

<template>
  <template v-if="hasItalicSuffix">{{ parts.body.slice(0, -italicSuffix.length) }}<i>{{ italicSuffix }}</i></template>
  <template v-else>{{ parts.body }}</template>
  <span v-if="parts.images.length" class="rail-fires" :class="{ 'rail-fires-after': parts.body, 'rail-skull': parts.skull }" role="img" :aria-label="parts.icons"><img v-for="(src, n) in parts.images" :key="n" class="rail-emoji" :src="src" alt="" /></span>
</template>
