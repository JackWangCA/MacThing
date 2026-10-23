<script setup>
import { computed } from 'vue';
const props = defineProps({
  text: { type: [String, Number], default: '' },
  italicSuffix: { type: String, default: '' }
});
// A trailing run of 🔥 (a hot pace, see usage.js) is drawn as bundled images after the text.
const parts = computed(() => {
  const [, body, fires] = String(props.text).match(/^(.*?)\s*((?:🔥)*)$/su);
  return { body, fires: [...fires].length };
});
const hasItalicSuffix = computed(() => props.italicSuffix && parts.value.body.endsWith(props.italicSuffix));
</script>

<template>
  <template v-if="hasItalicSuffix">{{ parts.body.slice(0, -italicSuffix.length) }}<i>{{ italicSuffix }}</i></template>
  <template v-else>{{ parts.body }}</template>
  <span v-if="parts.fires" class="rail-fires" :class="{ 'rail-fires-after': parts.body }" role="img" :aria-label="'🔥'.repeat(parts.fires)"><img v-for="n in parts.fires" :key="n" class="rail-emoji" src="images/emoji/1f525.svg" alt="" /></span>
</template>
