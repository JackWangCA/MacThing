<script setup>
import { computed, ref, watch } from 'vue';
import { state, CT } from '../state.js';
import LeftRail from '../components/LeftRail.vue';
import ScreenStage from '../components/ScreenStage.vue';
import AnalogClock from '../components/AnalogClock.vue';
import TimeTimer from '../components/TimeTimer.vue';
import { timer, total, remaining, timerLabel, timerTitle, stepPreset, currentMeetingKey, pickMeeting, toggleTimer, resetTimer, clearTimer } from '../timer.js';
const parts = computed(() => CT.parts(state.now));
const face = computed(() => state.settings.clockFace);
const time = computed(() => CT.clockText(parts.value));
const next = computed(() => state.calendar.status === 'ok' ? state.calendar.events.find(e => !e.allDay && e.start > state.now && CT.dayNumber(e.start) === CT.dayNumber(state.now)) : null);
// The clock button, pressed on the clock, swaps it for the timer and back. Knob and wheel work
// the timer only while it's up: turn to pick a length, press to start or pause, press twice to reset.
// Past 60 minutes there's a meeting stop: the end of the meeting going on now, or the start of
// the next one today. During a meeting the timer opens on it; reset there drops back to the
// preset, stopped.
const mode = ref('clock');
const screen = CT.screen('clock');
screen.reselect = () => {
  mode.value = mode.value === 'clock' ? 'timer' : 'clock';
  if (mode.value === 'timer') pickMeeting();
};
// While it's up and not started, a meeting that starts sets it too, as does one that turns up
// when the calendar first loads (after a reload that reopened the timer). It never starts or comes
// up by itself: that's the meeting alert's Start timer.
watch(currentMeetingKey, key => { if (key && mode.value === 'timer') pickMeeting(); });
// The meeting alert's start button: brings the timer up on the clock screen.
CT.showTimer = () => {
  mode.value = 'timer';
  CT.show('clock');
};
// A finished timer counts up past its time until you leave it, then goes back to its preset.
watch(() => mode.value === 'timer' && state.current === 'clock', up => { if (!up && timer.status === 'done') resetTimer(); });
// A meeting's timer counts on past its end for ten minutes at most, then puts itself away.
const MEETING_OVERRUN_MS = 10 * 60000;
CT.onSecond(now => {
  if (timer.status !== 'done' || !timer.meeting || now - timer.endsAt < MEETING_OVERRUN_MS) return;
  resetTimer();
  mode.value = 'clock';
});
screen.turn = steps => {
  if (mode.value === 'clock' || timer.status === 'running' || timer.status === 'paused') return false;
  stepPreset(steps);
};
let lastPress = 0;
screen.press = () => {
  if (mode.value === 'clock') return false;
  const t = performance.now();
  if (t - lastPress < (CT.config.multiClickMs || 350)) { clearTimer(); lastPress = 0; } else { toggleTimer(); lastPress = t; }
};
</script>
<template>
  <section id="screen-clock" class="screen fill flex" :class="{ active: state.current === 'clock', leaving: state.leaving === 'clock', timer: mode === 'timer' }">
    <LeftRail :view="mode" :views="{ clock: { eyebrow: CT.MONTHS[parts.month], title: parts.date, subtitle: CT.DAYS[parts.day] }, timer: { eyebrow: timerLabel, title: timerTitle, subtitle: time.time } }">
      <template #lower>
        <template v-if="next">{{ CT.timeText(next.start) }} <b class="primary medium">{{ next.title }}</b></template><template v-else-if="state.calendar.status === 'ok'">No events today</template>
      </template>
    </LeftRail>
    <ScreenStage class="bg-panel">
      <!-- Both faces stay drawn and only fade (see .fade-view), so a press doesn't have to build and
           paint the incoming one while the other is fading out. -->
      <div class="fade-view c-view-timer fill" :class="{ on: mode === 'timer' }"><TimeTimer :remaining="remaining" :total="total" :idle="timer.status === 'set' && !timer.meeting" /></div>
      <div class="fade-view fill" :class="{ on: mode === 'clock' }">
        <AnalogClock v-if="face !== 'digital'" :numbers="face === 'numbers'" :now="state.current === 'clock' ? state.now : 0" />
        <div v-else class="c-digital fill flex gap-10 tabular semibold"><span>{{ time.time }}</span><span class="c-digital-sec accent">{{ String(parts.seconds).padStart(2, '0') }}</span></div>
      </div>
    </ScreenStage>
  </section>
</template>
