<script setup>
import { computed } from 'vue';
const props = defineProps({
  text: { type: [String, Number], default: '' },
  italicSuffix: { type: String, default: '' }
});
const text = computed(() => String(props.text));
const fireParts = computed(() => text.value.split('🔥🔥🔥'));
const hasItalicSuffix = computed(() => props.italicSuffix && text.value.endsWith(props.italicSuffix));
</script>

<template>
  <template v-if="fireParts.length > 1">{{ fireParts[0] }}<span class="rail-fires" role="img" aria-label="🔥🔥🔥"><img v-for="n in 3" :key="n" class="rail-emoji" src="images/emoji/1f525.svg" alt="" /></span>{{ fireParts[1] }}</template>
  <template v-else>{{ hasItalicSuffix ? text.slice(0, -italicSuffix.length) : text }}<i v-if="hasItalicSuffix">{{ italicSuffix }}</i></template>
</template>
