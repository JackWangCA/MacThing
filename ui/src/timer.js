import { reactive, computed, watch } from 'vue';
import { state, CT } from './state.js';

// The Time Timer on the clock screen. It keeps its end time on the Mac's clock rather than
// counting seconds, so it stays right while another screen is up or the backlight is off.
export const PRESETS = [5, 10, 15, 30, 45, 60]; // minutes
// meeting, when set, is the timer's other length, a knob stop past 60 minutes: until the meeting
// going on now ends (kind 'end'), or, with none on, until the next one today starts ('start').
export const timer = reactive({ preset: 2, meeting: null, status: 'set', endsAt: 0, left: 0 }); // status: set | running | paused | done

const keyOf = e => (e.calendarId || '') + '|' + e.start + '|' + (e.title || '');
/** The timed event going on now, or null. With a few at once, the one that ends first. */
export const currentMeeting = computed(() => {
  if (state.calendar.status !== 'ok') return null;
  const on = state.calendar.events.filter(e => !e.allDay && e.start <= state.now && state.now < e.end);
  return on.length ? on.reduce((a, b) => (b.end < a.end ? b : a)) : null;
});
/** Which meeting is on, as a key: it changes only when a different one starts (or none is on). */
export const currentMeetingKey = computed(() => currentMeeting.value ? keyOf(currentMeeting.value) : '');
const meetingOf = (e, kind) => ({ key: keyOf(e), kind, title: e.title || '', start: e.start, end: e.end, length: 0 });
/** The next timed event still to start today, or null. */
const nextMeeting = computed(() => {
  if (state.calendar.status !== 'ok') return null;
  const today = CT.dayNumber(state.now);
  const later = state.calendar.events.filter(e => !e.allDay && e.start > state.now && CT.dayNumber(e.start) === today);
  return later.length ? later.reduce((a, b) => (b.start < a.start ? b : a)) : null;
});
/** The knob's meeting stop: the end of the meeting going on now, else the start of the next. */
const meetingStop = computed(() => currentMeeting.value ? meetingOf(currentMeeting.value, 'end')
  : nextMeeting.value ? meetingOf(nextMeeting.value, 'start') : null);
const stopId = computed(() => meetingStop.value ? [meetingStop.value.kind, meetingStop.value.key, meetingStop.value.end].join('|') : '');
const targetOf = m => (m.kind === 'start' ? m.start : m.end);

const presetMs = () => PRESETS[timer.preset] * 60000;
// Set to a meeting, it doesn't tick: it shows the minutes left, rounded up, "10 min" for 9:49.
const wholeMinutes = ms => Math.max(0, Math.ceil(ms / 60000) * 60000);
/** The timer's full turn: the preset; the whole meeting, counting to its end (so the dial shows
 *  how much is left); or, counting to the next one's start, the time there was when it started. */
export const total = computed(() => {
  const m = timer.meeting;
  if (!m) return presetMs();
  if (m.kind === 'end') return m.end - m.start;
  return timer.status === 'set' ? Math.max(60000, wholeMinutes(m.start - state.now)) : m.length;
});
export const remaining = computed(() => {
  if (timer.status === 'set') return timer.meeting ? wholeMinutes(targetOf(timer.meeting) - state.now) : presetMs();
  if (timer.status === 'running') return Math.max(0, timer.endsAt - state.now);
  return timer.left;
});
export const timerLabel = computed(() => {
  const minutes = PRESETS[timer.preset];
  const name = timer.meeting ? (timer.meeting.kind === 'start' ? 'Next meeting in' : 'Meeting ends in')
    : minutes === 60 ? '1 hour timer' : minutes + ' minute timer';
  return timer.status === 'paused' ? name + ' · Paused' : timer.status === 'done' ? "Time's up" : name;
});
/** 35:23 — whole seconds, rounded down. */
export function timerText(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
// Set to a meeting, the title is the minutes left, with timerUnit after it: 10 min.
const minutesOnly = computed(() => timer.status === 'set' && !!timer.meeting);
export const timerUnit = computed(() => (minutesOnly.value ? 'min' : ''));
/** Set, it shows the full length, 5:00. Started, it drops to 4:59 straight away so you can see
 *  it going, and reads 0:00 through its last second. Once the time is up it counts on past it,
 *  1:23+, until the timer's put away. Set to a meeting, it's the minutes left (timerUnit). */
export const timerTitle = computed(() =>
  minutesOnly.value ? String(remaining.value / 60000)
    : timer.status === 'set' ? timerText(remaining.value)
    : timer.status === 'done' ? timerText(state.now - timer.endsAt) + '+'
    : timerText(Math.ceil(remaining.value / 1000) * 1000 - 1000));

/** The knob's stops are the presets, then, past 60 minutes, the meeting stop if there is one. */
export function stepPreset(steps) {
  const last = meetingStop.value ? PRESETS.length : PRESETS.length - 1;
  const at = Math.max(0, Math.min(last, (timer.meeting ? PRESETS.length : timer.preset) + steps));
  if (at === PRESETS.length) timer.meeting = meetingStop.value;
  else { timer.meeting = null; timer.preset = at; }
  timer.status = 'set';
}
/** Opening the timer during a meeting sets it to the meeting's end, unless it's already going. */
export function pickMeeting() {
  if (timer.status === 'set' && currentMeeting.value) timer.meeting = meetingOf(currentMeeting.value, 'end');
}
/** The meeting alert's Start timer, or one queued from it as the meeting starts: starts the timer
 *  to that meeting's end, in place of whatever it was doing. It's the only way a meeting starts one. */
export function startMeetingTimer(e) {
  timer.meeting = meetingOf(e, 'end');
  timer.status = 'set';
  toggleTimer();
}
export function toggleTimer() {
  state.now = CT.now();
  if (timer.status === 'running') {
    timer.left = Math.max(0, timer.endsAt - state.now);
    timer.status = 'paused';
  } else if (timer.status === 'done') resetTimer();
  else {
    timer.endsAt = endOnHalfSecond(timer.status === 'paused' ? state.now + timer.left
      : timer.meeting ? targetOf(timer.meeting) : state.now + presetMs());
    if (timer.status === 'set' && timer.meeting) timer.meeting.length = timer.endsAt - state.now;
    timer.status = 'running';
  }
}
// The display only redraws on the shared tick, just after each of the Mac's whole seconds. If the
// timer's own seconds rolled over near that moment, the tick's jitter would decide which side it
// read — some seconds would show twice and others not at all. So the end is pulled back (never
// forward, so it still reads 4:59 the moment it starts) to half a second off the tick.
function endOnHalfSecond(ms) {
  return ms - ((ms - 505) % 1000 + 1000) % 1000;
}
export function resetTimer() {
  timer.status = 'set';
  if (timer.meeting) followMeeting();
}
/** Pressed twice: stop the timer and put it back to its preset. Set to a meeting, it's always
 *  counting down to the meeting, so reset leaves the meeting too; the knob's meeting stop (or
 *  opening the timer again during a meeting) brings it back. */
export function clearTimer() {
  timer.meeting = null;
  timer.status = 'set';
}
// Set to the meeting stop, the timer keeps up with it: a new time, the next meeting's start
// becoming that meeting's end as it begins, or, with no meeting left today, back to its preset.
function followMeeting() {
  timer.meeting = meetingStop.value;
}
watch(stopId, () => { if (timer.meeting && timer.status === 'set') followMeeting(); });
// Running on a meeting, it follows the meeting's time if that changes — unless it's been paused,
// when it's the timer's own time from then on.
watch(() => state.calendar, () => {
  const m = timer.meeting;
  if (!m || timer.status !== 'running' || state.calendar.status !== 'ok') return;
  const e = state.calendar.events.find(e => !e.allDay && keyOf(e) === m.key);
  if (!e || targetOf(meetingOf(e, m.kind)) === targetOf(m) || targetOf(meetingOf(e, m.kind)) <= state.now) return;
  timer.meeting = { ...meetingOf(e, m.kind), length: m.length };
  timer.endsAt = endOnHalfSecond(targetOf(timer.meeting));
});

function finish() {
  timer.status = 'done';
  timer.left = 0;
  CT.flash('timer', 'var(--orange)');
}
CT.onSecond(now => { if (timer.status === 'running' && now >= timer.endsAt) finish(); });
