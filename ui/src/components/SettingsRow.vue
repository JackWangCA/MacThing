<script setup>
defineProps({ label: String, value: String, selected: Boolean, link: Boolean });
</script>
<template>
  <div class="s-row flex items-center justify-between gap-16 font-small" :class="{ sel: selected }">
    <span class="medium flex-none truncate">{{ label }}</span><span class="s-value semibold muted flex items-center gap-8"><span class="truncate">{{ value }}</span><svg v-if="link" class="s-link flex-none"><use href="#i-open-on-mac" /></svg></span>
  </div>
</template>
