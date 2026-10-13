<script setup>
import { ref, watch, onUnmounted } from 'vue';
// tint: a colour laid over the art (the album art background's). Each layer keeps the tint it
// came with, so a new strength fades in with its art instead of jumping ahead of it.
const props = defineProps({ url: String, tint: { type: String, default: '' } });
const layers = ref(['', '']);
const front = ref(0);
// New art fades in over the old, which stays fully opaque underneath until it is covered. Fading
// both at once dips to half-transparent midway, so even two identical covers visibly blink.
// Going to no art fades the old one out instead, as there is nothing to cover it with.
const under = ref(-1);
const tints = ref(['', '']);
let timer;
watch(() => [props.url, props.tint], ([url, tint], old) => {
  // Only the tint changed (the theme did): the art on screen takes it.
  if (old && old[0] === url) { tints.value[front.value] = tint; return; }
  const previous = front.value;
  const next = 1 - previous;
  layers.value[next] = url || '';
  tints.value[next] = tint;
  front.value = next;
  under.value = url && layers.value[previous] ? previous : -1;
  clearTimeout(timer);
  timer = setTimeout(() => { layers.value[previous] = ''; under.value = -1; }, 600);
}, { immediate: true });
onUnmounted(() => clearTimeout(timer));
</script>
<template>
  <div class="art fill">
    <div v-for="(url, i) in layers" :key="i" class="art-layer fill" :class="{ front: i === front, under: i === under }">
      <div class="art-img fill" :style="{ backgroundImage: url ? 'url(' + JSON.stringify(url) + ')' : 'none' }" />
      <div v-if="url && tints[i]" class="fill" :style="{ background: tints[i] }" />
    </div>
  </div>
</template>
