<script setup>
import { computed, ref, watch, nextTick, onMounted } from "vue";
import { state, CT, reminderOverdue } from "../state.js";
import LeftRail from "../components/LeftRail.vue";
import ScreenStage from "../components/ScreenStage.vue";
import StageMessage from "../components/StageMessage.vue";
import CalendarEvent from "../components/CalendarEvent.vue";
import CalendarMonth from "../components/CalendarMonth.vue";
import ReminderItem from "../components/ReminderItem.vue";
const rail = ref(null),
  list = ref(null),
  kept = ref([]),
  dueList = ref(null),
  keptDue = ref([]);
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
// Today, Tomorrow, then weekday names — the heading each list groups under.
const dayLabel = (i) =>
  i === 0 ? "Today" : i === 1 ? "Tomorrow" : CT.DAYS[CT.parts(state.now + i * 86400000).day];
const sections = computed(() => {
  if (state.calendar.status !== "ok") return [];
  const today = CT.dayNumber(state.now);
  return Array.from({ length: days.value }, (_, i) => ({
    label: dayLabel(i),
    items: state.calendar.events
      .filter((e) =>
        i === 0
          ? e.end > state.now && CT.dayNumber(e.start) <= today
          : CT.dayNumber(e.start) === today + i,
      )
      .sort((a, b) => b.allDay - a.allDay || a.start - b.start),
  })).filter((s) => s.items.length);
});
// Reminders, grouped the same way with anything past its deadline gathered at the top. Whether
// something is overdue is decided here against the live clock, not when the Mac last read the
// list, so a deadline passing moves it without waiting for the next refresh.
const dueSections = computed(() => {
  if (state.dueReminders.status !== "ok") return [];
  const today = CT.dayNumber(state.now);
  const due = state.dueReminders.reminders;
  return [
    { label: "Overdue", items: due.filter((r) => reminderOverdue(r, state.now)) },
    ...Array.from({ length: days.value }, (_, i) => ({
      label: dayLabel(i),
      items: due.filter(
        (r) => !reminderOverdue(r, state.now) && CT.dayNumber(r.due) === today + i,
      ),
    })),
  ].filter((s) => s.items.length);
});
// The rail's line under the reminders: what's late, else what's still to come today.
const dueLine = computed(() => {
  if (state.dueReminders.status !== "ok") return "";
  const due = state.dueReminders.reminders;
  const late = due.filter((r) => reminderOverdue(r, state.now)).length;
  const today = due.filter(
    (r) => !reminderOverdue(r, state.now) && CT.dayNumber(r.due) === CT.dayNumber(state.now),
  ).length;
  return late ? late + " overdue" : today ? today + " due today" : "Nothing due today";
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
const dueMessage = computed(() => {
  const status = state.dueReminders.status;
  if (["denied", "restricted", "writeOnly"].includes(status))
    return {
      title: "Reminders access is off",
      detail:
        "Allow “Car Thing Helper” in System Settings → Privacy & Security → Reminders.",
    };
  if (["loading", "notDetermined"].includes(status))
    return { title: "Loading your reminders…" };
  if (status !== "ok")
    return { title: "Reminders unavailable", detail: "Trying again shortly." };
  if (!dueSections.value.length)
    return {
      title: "Nothing due",
      detail:
        days.value > 1
          ? "Nothing with a deadline in the next " + days.value + " days."
          : "Nothing with a deadline today.",
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
// A list shrinks until it fits its stage. Today comes first: the last day gives up items until
// it's just its heading and a count, then goes, and only once it's down to today do today's own
// items start to go. One generation counter per list, so a re-fit abandons the run before it.
const generations = { agenda: 0, due: 0 };
async function fitList(name, element, sections, kept) {
  const run = ++generations[name];
  kept.value = sections.map((s) => ({ ...s, shown: s.items.length }));
  await nextTick();
  while (
    run === generations[name] &&
    element.value &&
    element.value.scrollHeight > element.value.clientHeight
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
// Only the view on screen can be measured — a hidden one has no height — so both are re-fitted
// whenever the view changes as well as whenever their contents do.
function fitLists() {
  fitList("agenda", list, sections.value, kept);
  fitList("due", dueList, dueSections.value, keptDue);
}
// The calendar button, pressed on the calendar, steps from the agenda to the month, then to
// what's due in Reminders, then back to the agenda.
const VIEWS = ["agenda", "month", "reminders"];
const view = ref("agenda");
// Separate sources, each compared on its own: one getter returning a fresh array would count
// as a change on every tick and rebuild the agenda each second rather than each minute.
watch(
  [
    () => state.calendar,
    () => state.dueReminders,
    () => state.settings,
    () => Math.floor(state.now / 60000),
    () => state.current,
    () => view.value,
  ],
  () => {
    nextTick(fitClock);
    fitLists();
  },
);
const screen = CT.screen("calendar");
screen.show = () => {
  nextTick(fitClock);
  fitLists();
};
screen.reselect = () => {
  view.value = VIEWS[(VIEWS.indexOf(view.value) + 1) % VIEWS.length];
};
onMounted(() => {
  fitClock();
  fitLists();
  if (document.fonts)
    document.fonts.ready.then(() => {
      fitClock();
      fitLists();
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
          ><span v-else-if="view === 'reminders'">{{ dueLine }}</span></Transition
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
            v-for="(event, i) in section.items.slice(0, section.shown)"
            :key="i"
            :event="event"
            :now="state.now"
          />
          <div
            v-if="section.items.length > section.shown"
            class="mt-16 font-small medium muted"
          >
            {{
              section.shown
                ? "+" + (section.items.length - section.shown) + " more"
                : section.items.length +
                  (section.items.length === 1 ? " event" : " events")
            }}
          </div>
        </template>
      </div></Transition>
      <Transition name="view"><div v-show="view === 'reminders'" ref="dueList" class="k-list k-due overflow-hidden stage-safe">
        <template v-for="section in keptDue" :key="section.label">
          <div
            class="k-day font-small medium"
            :class="{ muted: section.label !== 'Overdue' && section.label !== 'Today' }"
          >
            {{ section.label }}
          </div>
          <ReminderItem
            v-for="(reminder, i) in section.items.slice(0, section.shown)"
            :key="i"
            :reminder="reminder"
            :now="state.now"
          />
          <div
            v-if="section.items.length > section.shown"
            class="mt-16 font-small medium muted"
          >
            {{
              section.shown
                ? "+" + (section.items.length - section.shown) + " more"
                : section.items.length +
                  (section.items.length === 1 ? " reminder" : " reminders")
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
      <Transition name="view"
        ><StageMessage
          v-if="view === 'reminders'"
          :title="dueMessage.title"
          :detail="dueMessage.detail"
      /></Transition>
    </ScreenStage>
  </section>
</template>
