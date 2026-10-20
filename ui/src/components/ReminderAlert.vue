<script setup>
import { computed, ref } from 'vue';
import { state, CT } from '../state.js';
// Settings → Reminders (on the Mac): "Drink water" every so often, as a card like the meeting
// alert's. The Mac decides when one is due and sends it here. First pass:
// - Any press dismisses it ("Done"); left alone, it goes after SHOW_MS by itself.
// - A meeting's card comes first: a reminder waits under it and shows once it's dismissed.
// - Only one card at a time. The same reminder due again replaces itself rather than queuing.
const SHOW_MS = 60000;
const queue = ref([]); // reminders due and not yet dismissed, oldest first
CT.on('reminder', msg => {
  const r = msg.reminder;
  queue.value = queue.value.filter(x => x.id !== r.id).concat({ ...r, shownAt: 0 });
});
// The meeting alert (mounted first) owns the modal hooks; chain onto them so it goes first.
const meetingOpen = CT.modalOpen || (() => false);
const meetingDismiss = CT.dismissModal || (() => false);
const reminder = computed(() => (meetingOpen() ? null : queue.value[0] || null));
function done() {
  queue.value = queue.value.slice(1);
}
// The clock ticks once a second; a card left alone that long goes by itself.
CT.onSecond(now => {
  const r = queue.value[0];
  if (!r || meetingOpen()) return;
  if (!r.shownAt) r.shownAt = now;
  else if (now - r.shownAt >= SHOW_MS) done();
});
CT.modalOpen = () => meetingOpen() || !!reminder.value;
CT.dismissModal = key => {
  if (meetingDismiss(key)) return true;
  if (!reminder.value) return false;
  done();
  return true;
};
const every = computed(() => {
  const m = reminder.value.every;
  return 'Every ' + (m % 60 ? m + ' min' : m / 60 + (m === 60 ? ' hour' : ' hours'));
});
</script>
<template>
  <div class="meeting-alert reminder-alert fill flex" :class="{ on: !!reminder }">
    <div v-if="reminder" class="m-card flex-col">
      <div class="m-title clamp-2">{{ reminder.text }}</div>
      <div class="m-foot flex">
        <div class="m-when r-every">{{ every }}</div>
        <div class="m-start">Done</div>
      </div>
    </div>
  </div>
</template>
