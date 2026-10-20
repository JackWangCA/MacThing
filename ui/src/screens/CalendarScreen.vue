<script setup>
import { computed, ref, watch, nextTick, onMounted } from "vue";
import { state, CT } from "../state.js";
import LeftRail from "../components/LeftRail.vue";
import ScreenStage from "../components/ScreenStage.vue";
import StageMessage from "../components/StageMessage.vue";
import CalendarEvent from "../components/CalendarEvent.vue";
import CalendarMonth from "../components/CalendarMonth.vue";
const rail = ref(null),
  list = ref(null),
  kept = ref([]);
const parts = computed(() => CT.parts(state.now));
const time = computed(() => CT.clockText(parts.value).time);
const days = computed(() => state.settings.calendarDays || 2);
const next = computed(() =>
  state.calendar.status === "ok"
    ? state.calendar.events.find(
        (e) =>
          !e.allDay &&
          e.start > state.now &&
          CT.dayNumber(e.start) === CT.dayNumber(state.now),
      )
    : null,
);
const sections = computed(() => {
  if (state.calendar.status !== "ok") return [];
  const today = CT.dayNumber(state.now);
  return Array.from({ length: days.value }, (_, i) => ({
    label:
      i === 0
        ? "Today"
        : i === 1
          ? "Tomorrow"
          : CT.DAYS[CT.parts(state.now + i * 86400000).day],
    events: state.calendar.events
      .filter((e) =>
        i === 0
          ? e.end > state.now && CT.dayNumber(e.start) <= today
          : CT.dayNumber(e.start) === today + i,
      )
      .sort((a, b) => b.allDay - a.allDay || a.start - b.start),
  })).filter((s) => s.events.length);
});
const message = computed(() => {
  const status = state.calendar.status;
  if (["denied", "restricted", "writeOnly"].includes(status))
    return {
      title: "Calendar access is off",
      detail:
        "Allow “Car Thing Helper” in System Settings → Privacy & Security → Calendars.",
    };
  if (["loading", "notDetermined"].includes(status))
    return { title: "Loading your calendar…" };
  if (status !== "ok")
    return { title: "Calendar unavailable", detail: "Trying again shortly." };
  if (!sections.value.length)
    return {
      title: "Nothing scheduled",
      detail:
        days.value > 1
          ? "The next " + days.value + " days are clear."
          : "The rest of the day is clear.",
    };
  return {};
});
// JS overrides the CSS display-size fallback only when the current time is too wide.
function fitClock() {
  const clock = rail.value && rail.value.titleElement;
  if (!clock) return;
  clock.style.fontSize = "";
  for (let size = 104; clock.scrollWidth > clock.clientWidth && size > 72; ) {
    size -= 8;
    clock.style.fontSize = size + "px";
  }
}
let generation = 0;
async function fitEvents() {
  const run = ++generation;
  kept.value = sections.value.map((s) => ({ ...s, shown: s.events.length }));
  await nextTick();
  // Today comes first: the last day gives up events until it's just its heading and a count,
  // then goes, and only once it's down to today do today's own events start to go.
  while (
    run === generation &&
    list.value &&
    list.value.scrollHeight > list.value.clientHeight
  ) {
    const last = kept.value[kept.value.length - 1];
    if (kept.value.length > 1) {
      if (last.shown > 0) last.shown--;
      else kept.value.pop();
    } else if (last.shown > 1) last.shown--;
    else break;
    await nextTick();
  }
}
// Separate sources, each compared on its own: one getter returning a fresh array would count
// as a change on every tick and rebuild the agenda each second rather than each minute.
watch(
  [
    () => state.calendar,
    () => state.settings,
    () => Math.floor(state.now / 60000),
    () => state.current,
  ],
  () => {
    nextTick(fitClock);
    fitEvents();
  },
);
// The calendar button, pressed on the calendar, swaps the agenda for the month and back.
const view = ref("agenda");
const screen = CT.screen("calendar");
screen.show = () => {
  nextTick(fitClock);
  fitEvents();
};
screen.reselect = () => {
  view.value = view.value === "agenda" ? "month" : "agenda";
};
onMounted(() => {
  fitClock();
  fitEvents();
  if (document.fonts)
    document.fonts.ready.then(() => {
      fitClock();
      fitEvents();
    });
});
</script>
<template>
  <section
    id="screen-calendar"
    class="screen fill flex"
    :class="{ active: state.current === 'calendar', leaving: state.leaving === 'calendar' }"
  >
    <LeftRail
      ref="rail"
      variant="time"
      :eyebrow="CT.DAYS[parts.day] + ' ' + (parts.month + 1) + '/' + parts.date"
      :title="time"
    >
      <template #lower>
        <Transition name="view"
          ><span v-if="view === 'month'"
            ><template v-if="next"
              >{{ CT.timeText(next.start) }}
              <b class="primary medium">{{ next.title }}</b></template
            ><template v-else-if="state.calendar.status === 'ok'"
              >No events today</template
            ></span
          ></Transition
        >
      </template>
    </LeftRail>
    <ScreenStage class="bg-panel">
      <Transition name="view"
        ><CalendarMonth v-if="view === 'month'" class="stage-safe" :now="state.now"
      /></Transition>
      <Transition name="view"><div v-show="view === 'agenda'" ref="list" class="k-list overflow-hidden stage-safe">
        <template v-for="section in kept" :key="section.label">
          <div
            v-if="section.label"
            class="k-day font-small medium"
            :class="{ muted: section.label !== 'Today' }"
          >
            {{ section.label }}
          </div>
          <CalendarEvent
            v-for="(event, i) in section.events.slice(0, section.shown)"
            :key="i"
            :event="event"
            :now="state.now"
          />
          <div
            v-if="section.events.length > section.shown"
            class="mt-16 font-small medium muted"
          >
            {{
              section.shown
                ? "+" + (section.events.length - section.shown) + " more"
                : section.events.length +
                  (section.events.length === 1 ? " event" : " events")
            }}
          </div>
        </template>
      </div></Transition>
      <Transition name="view"
        ><StageMessage
          v-if="view === 'agenda'"
          :title="message.title"
          :detail="message.detail"
      /></Transition>
    </ScreenStage>
  </section>
</template>
