<script setup>
defineProps({ title: String, detail: String });
</script>
<template><div v-if="title" class="stage-message flex-col center text-center font-medium semibold"><slot name="icon" />{{ title }}<small v-if="detail" class="mt-12 font-small weight-light muted">{{ detail }}</small></div></template>
