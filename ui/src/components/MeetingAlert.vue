<script setup>
import { computed, reactive } from 'vue';
import { state, CT } from '../state.js';
import { startMeetingTimer } from '../timer.js';
// Settings → Meeting alerts: a sheet over the bottom of every screen from a timed event's alert
// (its own, from the Mac's Calendar, or a fixed few minutes before) until the meeting ends. Once
// the meeting has started, the back button under the knob starts the clock's timer on it and
// dismisses it; any other press (and the back button before then) only dismisses it — until the
// meeting starts, if it hasn't yet, so every meeting's card is up at its start time. Turning the
// knob still sets the volume.
// A zero-length event (a reminder at 6:34) has no end to wait for: its card stays five minutes.
const REMINDER_MS = 5 * 60000;
// Of an event's own alerts, only those in the last hour count: a "1 day before" alert is a
// reminder, not a reason to cover the screen for a day.
const EVENT_ALERT_MAX_MS = 60 * 60000;
const STORE = 'ct-dismissed-meetings';
const keyOf = e => (e.calendarId || '') + '|' + e.start + '|' + (e.title || '');
// Each dismissed card's key → when it may come back. Kept across page reloads (dev, a bridge
// restart) so a dismissed alert doesn't come back early.
const dismissed = reactive(load());
function load() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; }
}
function save() {
  Object.keys(dismissed).forEach(key => { if (dismissed[key] < state.now) delete dismissed[key]; });
  try { localStorage.setItem(STORE, JSON.stringify(dismissed)); } catch (e) {}
}
// How long before the start an event's card appears, or null with alerts off. Every timed event
// gets one: with "Event's alert", one without an alert of its own (in the last hour) gets it as
// it starts, so its Start timer is there.
function leadMs(e) {
  const setting = state.settings.meetingAlert;
  if (!setting) return null;
  if (setting !== 'event') return setting * 60000;
  const leads = (e.alerts || []).filter(ms => ms <= EVENT_ALERT_MAX_MS).map(ms => Math.max(0, ms));
  return leads.length ? Math.max.apply(null, leads) : 0;
}
const untilOf = e => (e.end > e.start ? e.end : e.start + REMINDER_MS);
// Every timed event whose card is due now.
const due = computed(() => {
  if (state.calendar.status !== 'ok') return [];
  return state.calendar.events.filter(e => {
    if (e.allDay || dismissed[keyOf(e)] > state.now) return false;
    const lead = leadMs(e);
    return lead != null && e.start - lead <= state.now && state.now < untilOf(e);
  });
});
// One meeting at a time: the one that started last, so each meeting's card is up as it starts
// even when it overlaps another; before any has started, the next to start. Of meetings that
// start together, the one that ends first, as the timer's meeting stop picks.
const pick = (later) => (a, b) => (b.start !== a.start ? (b.start > a.start) === later : b.end < a.end) ? b : a;
const event = computed(() => {
  const started = due.value.filter(e => e.start <= state.now);
  if (started.length) return started.reduce(pick(true));
  return due.value.length ? due.value.reduce(pick(false)) : null;
});
// Only once the meeting has started (and a zero-length reminder has nothing to time).
const canStart = computed(() => event.value.start <= state.now && state.now < event.value.end);
// The timer it starts runs to the meeting's end: "Start 30 min timer", in minutes rounded up as
// the timer's own meeting stop shows them. With meetings at once, it says which one it is.
const startMinutes = computed(() => Math.ceil((event.value.end - state.now) / 60000));
CT.dismissModal = key => {
  if (!event.value) return false;
  if (key === 'Escape' && canStart.value) {
    startMeetingTimer(event.value);
    CT.showTimer();
  }
  // A press dismisses only this card. Before the meeting starts, it comes back as it does.
  const e = event.value;
  dismissed[keyOf(e)] = e.start > state.now ? e.start : untilOf(e);
  save();
  return true;
};
const when = computed(() => {
  const minutes = Math.round((event.value.start - state.now) / 60000);
  if (minutes > 0) return 'In ' + minutes + ' min';
  if (minutes < 0) return -minutes + ' min ago';
  return 'Starting now';
});
// "2:00 – 2:30 PM", keeping both AM/PMs only when the meeting spans noon or midnight; just
// "2:00 PM" for a zero-length event.
const range = computed(() => {
  if (event.value.end <= event.value.start) return CT.timeText(event.value.start);
  const start = CT.clockText(CT.parts(event.value.start)), end = CT.clockText(CT.parts(event.value.end));
  return (start.ampm === end.ampm ? start.time : start.time + ' ' + start.ampm) + ' – ' + end.time + (end.ampm ? ' ' + end.ampm : '');
});
// A video call's location is its link (with a passcode in it, often): show the service instead.
const SERVICES = [[/(^|\.)zoom\.us$/, 'Zoom'], [/^meet\.google\.com$/, 'Google Meet'], [/^teams\.(microsoft|live)\.com$/, 'Microsoft Teams'], [/(^|\.)webex\.com$/, 'Webex'], [/^facetime\.apple\.com$/, 'FaceTime']];
function place(location) {
  const line = (location || '').split('\n')[0].trim();
  const link = /^https?:\/\/([^/?#]+)/i.exec(line);
  if (!link) return line;
  const host = link[1].toLowerCase().replace(/^www\./, '');
  const service = SERVICES.find(s => s[0].test(host));
  return service ? service[1] : host;
}
// With no location, a call link from the event's URL or notes (the helper finds it) says where.
const where = computed(() => place(event.value.location) || place(event.value.call));
</script>
<template>
  <div class="meeting-alert fill flex" :class="{ on: !!event }">
    <div v-if="event" class="m-card flex-col">
      <div class="flex">
        <div class="m-bar flex-none" :style="{ background: event.color }" />
        <div class="flex-1 flex-col">
          <div class="m-title clamp-2">{{ event.title || 'Untitled' }}</div>
          <div class="m-range m-detail secondary tabular">{{ range }}</div>
          <div v-if="where" class="m-where m-detail muted truncate">{{ where }}</div>
        </div>
      </div>
      <div class="m-foot flex">
        <div class="m-when">{{ when }}</div>
        <div v-if="canStart" class="m-start">Start {{ startMinutes }} min timer</div>
      </div>
    </div>
  </div>
</template>
