<script setup>
import { computed, ref } from 'vue';
import RailText from './RailText.vue';
const props = defineProps({
  eyebrow: { type: String, default: '' },
  title: { type: [String, Number], default: '' },
  subtitle: { type: String, default: '' },
  lowerContent: { type: String, default: '' },
  variant: { type: String, default: 'display' },
  view: { type: String, default: '' }, // a change fades the text out and the new text in
  // Optional { [view]: { eyebrow, title, titleClass, italicSuffix, unit, subtitle, subtitleNote, subtitleClass } }: every view's text stays drawn and `view`
  // picks the one showing, so a switch only fades (see .fade-view) instead of building new text.
  // unit, if any, follows the title in small type (24 min); subtitleNote follows the subtitle, muted (Week: 0.3x · 30%).
  views: { type: Object, default: null },
  truncateLower: { type: Boolean, default: true },
  mutedSubtitle: Boolean
});
const titleElement = ref(null), subtitleElement = ref(null);
defineExpose({ titleElement, subtitleElement });
const eyebrowClass = computed(() => ['font-small bold', props.variant === 'media' ? 'clamp-2' : 'truncate']);
const titleClass = computed(() => [props.variant === 'media' ? 'np-title' : props.variant === 'instructions' ? 'font-medium semibold' : 'font-huge', { 'calendar-time overflow-hidden': props.variant === 'time' }]);
const subtitleClass = computed(() => [props.variant === 'media' || props.variant === 'instructions' ? 'font-small weight-light' : 'font-medium semibold', { 'clamp-2': props.variant === 'media', muted: props.mutedSubtitle || props.variant === 'instructions' }]);
</script>

<template>
  <div class="left-rail flex-col justify-between" :data-variant="variant">
    <div v-if="views" class="left-rail-views">
      <div v-for="(v, key) in views" :key="key" class="left-rail-content left-rail-view fade-view flex-col gap-12" :class="{ on: key === view }" :data-view="key">
        <p v-if="v.eyebrow" :class="eyebrowClass">{{ v.eyebrow }}</p>
        <h2 :class="[titleClass, v.titleClass]"><RailText :text="v.title" :italic-suffix="v.italicSuffix" /><span v-if="v.unit" class="lr-unit">{{ v.unit }}</span></h2>
        <div v-if="v.subtitle" :class="[subtitleClass, v.subtitleClass]"><RailText :text="v.subtitle" /><span v-if="v.subtitleNote" class="muted">{{ ' ' + v.subtitleNote }}</span></div>
      </div>
    </div>
    <Transition v-else name="view"><div :key="view" class="left-rail-content flex-col gap-12" :data-view="view">
      <p v-if="eyebrow || $slots.eyebrow" :class="eyebrowClass"><slot name="eyebrow">{{ eyebrow }}</slot></p>
      <h2 ref="titleElement" :class="titleClass"><slot name="title">{{ title }}</slot></h2>
      <div v-if="subtitle || $slots.subtitle" ref="subtitleElement" :class="subtitleClass"><slot name="subtitle">{{ subtitle }}</slot></div>
    </div></Transition>
    <div v-if="lowerContent || $slots.lower" class="flex-none font-small muted" :class="[variant === 'instructions' ? 'weight-light' : 'medium', { truncate: variant !== 'instructions' && truncateLower }]"><slot name="lower">{{ lowerContent }}</slot></div>
  </div>
</template>
