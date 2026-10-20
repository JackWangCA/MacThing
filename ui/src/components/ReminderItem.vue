<script setup>
import { computed } from 'vue';
import { CT, reminderOverdue } from '../state.js';
const props = defineProps({ reminder: Object, now: Number });
const overdue = computed(() => reminderOverdue(props.reminder, props.now));
// A whole-day reminder has no time of its own, so it reads the way an all-day event does rather
// than claiming to be due at midnight. Overdue says so instead of the time it went past.
const when = computed(() =>
  overdue.value ? 'DUE' : props.reminder.hasTime ? CT.timeText(props.reminder.due) : 'All day');
</script>
<template>
  <!-- The same row as CalendarEvent, down to the monochrome bar: overdue borrows the highlight an
       in-progress event gets, and a whole-day reminder borrows the all-day treatment. -->
  <div class="k-event flex font-small" :class="{ now: overdue, 'all-day': !reminder.hasTime && !overdue }">
    <div class="k-bar flex-none" />
    <div class="k-body flex-1">
      <div class="flex"><span class="k-time flex-none secondary medium">{{ when }}</span><span class="k-title flex-1 semibold truncate">{{ reminder.title || 'Untitled' }}</span></div>
      <div class="mt-4 weight-light muted truncate">{{ reminder.list }}</div>
    </div>
  </div>
</template>
