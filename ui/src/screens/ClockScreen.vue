<script setup>
import { computed, ref, watch } from 'vue';
import { state, CT } from '../state.js';
import LeftRail from '../components/LeftRail.vue';
import ScreenStage from '../components/ScreenStage.vue';
import AnalogClock from '../components/AnalogClock.vue';
import TimeTimer from '../components/TimeTimer.vue';
import ClaudeUsage from '../components/ClaudeUsage.vue';
import BackActionIcon from '../components/BackActionIcon.vue';
import { SESSION_MS, WEEK_MS, paceNumber, untilText, usageProviders, usageOf, usageName, usageUpdatedText } from '../usage.js';
import { timer, total, remaining, timerLabel, timerTitle, stepPreset, currentMeetingKey, pickMeeting, autoStartMeeting, toggleTimer, resetTimer, clearTimer } from '../timer.js';
const parts = computed(() => CT.parts(state.now));
const face = computed(() => state.settings.clockFace);
const time = computed(() => CT.clockText(parts.value));
const next = computed(() => state.calendar.status === 'ok' ? state.calendar.events.find(e => !e.allDay && e.start > state.now && CT.dayNumber(e.start) === CT.dayNumber(state.now)) : null);
// The clock button, pressed on the clock, steps it to the timer, then each usage Settings → Usage
// asks for (Claude, ChatGPT, both or none), then back. Knob and wheel work the timer only while
// it's up: turn to pick a length, press to start or pause, press twice to reset. During a meeting
// it opens set to the meeting's end, a stop just left of 5 minutes; reset there drops back to the
// preset, stopped. Opening a usage asks the Mac for fresh numbers (Claude's at most once a minute).
const providers = computed(() => usageProviders(state));
const modes = computed(() => ['clock', 'timer', ...providers.value]);
const isUsage = m => m === 'claude' || m === 'chatgpt';
const mode = ref('clock');
const screen = CT.screen('clock');
screen.reselect = () => {
  mode.value = modes.value[(modes.value.indexOf(mode.value) + 1) % modes.value.length];
  if (mode.value === 'timer') pickMeeting();
  if (isUsage(mode.value)) CT.send({ type: 'refreshUsage' });
};
screen.show = () => { if (isUsage(mode.value)) CT.send({ type: 'refreshUsage' }); };
// Once a usage's "10m ⟳" is up, the back button asks the Mac to try again instead of favoriting:
// the ⟳ turns once, then ••• until the Mac says it's done. Still stale after that, it shows ✕
// until another try is allowed. One try at a time, a minute apart at least (Claude's own ask
// limit), so pressing it again and again doesn't reach the service; a press too soon says how long.
const REFRESH_SPIN_MS = 600, REFRESH_COOLDOWN_MS = 60000, REFRESH_GIVE_UP_MS = 30000, WAIT_SHOWN_MS = 2000;
let refreshAt = -Infinity, refreshDone = true, refreshProvider = '', giveUpTimer = null, waitTimer = null;
const isStale = provider => !!usageUpdatedText(usageOf(state, provider), state.now);
function settleRefresh() {
  state.usageRefresh = isStale(refreshProvider) ? 'failed' : '';
  const left = refreshAt + REFRESH_COOLDOWN_MS - performance.now();
  if (state.usageRefresh) setTimeout(() => { if (state.usageRefresh === 'failed') state.usageRefresh = ''; }, left);
}
function finishRefresh() {
  if (refreshDone) return;
  refreshDone = true;
  clearTimeout(giveUpTimer);
  if (state.usageRefresh === 'pending') settleRefresh();
}
CT.on('usageRefreshed', finishRefresh);
screen.back = () => {
  if (mode.value === 'timer') return timerBackPress();
  if (!isUsage(mode.value) || !isStale(mode.value)) return false;
  if (state.usageRefresh === 'spin' || state.usageRefresh === 'pending') return;
  const wait = refreshAt + REFRESH_COOLDOWN_MS - performance.now();
  if (wait > 0) {
    state.usageRefreshWait = 'wait ' + Math.ceil(wait / 1000) + 's';
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => { state.usageRefreshWait = ''; }, WAIT_SHOWN_MS);
    return;
  }
  refreshAt = performance.now();
  refreshDone = false;
  refreshProvider = mode.value;
  state.usageRefresh = 'spin';
  CT.send({ type: 'refreshUsage', ack: true });
  setTimeout(() => { if (refreshDone) settleRefresh(); else state.usageRefresh = 'pending'; }, REFRESH_SPIN_MS);
  giveUpTimer = setTimeout(finishRefresh, REFRESH_GIVE_UP_MS);
};
// On the timer, the back button starts it, pauses it while it runs, and resets it once it's
// paused or done; the corner says which.
const TIMER_BACK = { set: ['start', 'play'], running: ['pause', 'pause'], paused: ['reset', 'refresh'], done: ['reset', 'refresh'] };
const timerBack = computed(() => TIMER_BACK[timer.status]);
function timerBackPress() {
  if (timer.status === 'paused' || timer.status === 'done') clearTimer(); else toggleTimer();
}
// A usage that's been taken out of Settings → Usage while it's up gives way to the clock.
watch(providers, list => { if (isUsage(mode.value) && !list.includes(mode.value)) mode.value = 'clock'; });
// Each usage's rail says how worried to be about the session, and the week under it (see usage.js).
function usageRail(provider) {
  const u = usageOf(state, provider);
  if (u.status !== 'ok') return { eyebrow: usageName(provider) + ' usage', title: '--', subtitle: '' };
  return {
    italicSuffix: 'x',
    subtitleClass: 'usage-week',
    eyebrow: 'Session: ' + Math.round(u.session.percent) + '% used',
    title: paceNumber(u.session, SESSION_MS, state.now),
    subtitle: 'Week: ' + Math.round(u.week.percent) + '% [' + paceNumber(u.week, WEEK_MS, state.now) + ']'
  };
}
const railViews = computed(() => {
  const views = { clock: { eyebrow: CT.MONTHS[parts.value.month], title: parts.value.date, subtitle: CT.DAYS[parts.value.day] }, timer: { eyebrow: timerLabel.value, title: timerTitle.value, subtitle: time.value.time } };
  providers.value.forEach(p => { views[p] = usageRail(p); });
  return views;
});
// On a usage, the line at the bottom is when its windows reset instead of the next event.
const resets = computed(() => {
  if (!isUsage(mode.value)) return null;
  const u = usageOf(state, mode.value);
  return u.status === 'ok' ? { session: untilText(u.session.resetsAt, state.now, SESSION_MS), week: untilText(u.week.resetsAt, state.now, WEEK_MS) } : null;
});
// While it's up and not started, a meeting that starts sets it too, as does one that turns up
// when the calendar first loads (after a reload that reopened the timer). With Settings → Meeting
// timer on, a meeting that starts (or is on when it's turned on) starts the timer, puts it up in
// place of the clock and switches to it — unless Settings is open on the device.
watch([currentMeetingKey, () => state.settings.meetingTimer], ([key]) => {
  if (!key) return;
  if (autoStartMeeting()) {
    mode.value = 'timer';
    if (state.current !== 'settings') CT.show('clock');
  } else if (mode.value === 'timer') pickMeeting();
});
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
  if (mode.value !== 'timer' || timer.status === 'running' || timer.status === 'paused') return false;
  stepPreset(steps);
};
let lastPress = 0;
screen.press = () => {
  if (mode.value !== 'timer') return false;
  const t = performance.now();
  if (t - lastPress < (CT.config.multiClickMs || 350)) { clearTimer(); lastPress = 0; } else { toggleTimer(); lastPress = t; }
};
</script>
<template>
  <section id="screen-clock" class="screen fill flex" :class="{ active: state.current === 'clock', leaving: state.leaving === 'clock', timer: mode === 'timer' }">
    <LeftRail :view="mode" :views="railViews" :truncate-lower="!resets">
      <template #lower>
        <template v-if="resets"><div class="usage-resets">Resets: Session <b class="primary medium">{{ resets.session }}</b> · Week <b class="primary medium">{{ resets.week }}</b></div></template>
        <template v-else-if="next">{{ CT.timeText(next.start) }} <b class="primary medium">{{ next.title }}</b></template><template v-else-if="state.calendar.status === 'ok'">No events today</template>
      </template>
    </LeftRail>
    <ScreenStage class="bg-panel">
      <!-- Every view stays drawn and only fades (see .fade-view), so a press doesn't have to build and
           paint the incoming one while the other is fading out. -->
      <div class="fade-view c-view-timer fill" :class="{ on: mode === 'timer' }"><TimeTimer :remaining="remaining" :total="total" :idle="timer.status === 'set' && !timer.meeting" /><div class="back-action font-small medium primary">{{ timerBack[0] }} <BackActionIcon :name="timerBack[1]" /></div></div>
      <div v-for="p in providers" :key="p" class="fade-view fill" :class="{ on: mode === p }"><ClaudeUsage :provider="p" /></div>
      <div class="fade-view fill" :class="{ on: mode === 'clock' }">
        <AnalogClock v-if="face !== 'digital'" :numbers="face === 'numbers'" :now="state.current === 'clock' ? state.now : 0" />
        <div v-else class="c-digital fill flex gap-10 tabular semibold"><span>{{ time.time }}</span><span class="c-digital-sec accent">{{ String(parts.seconds).padStart(2, '0') }}</span></div>
      </div>
    </ScreenStage>
  </section>
</template>
