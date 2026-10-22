<script setup>
import { computed, ref } from 'vue';
import { state, CT } from '../state.js';
import LeftRail from '../components/LeftRail.vue';
import ScreenStage from '../components/ScreenStage.vue';
import SettingsRow from '../components/SettingsRow.vue';
const rows = [
  { key: 'theme', label: 'Appearance', options: [['dark', 'Dark'], ['light', 'Light'], ['auto', 'Match Mac']] },
  { key: 'artBackground', label: 'Album art background', options: [[false, 'Off'], [true, 'On']] },
  { key: 'meetingAlert', label: 'Meeting alerts', options: [[0, 'Off'], ['event', 'Event’s alert'], [1, '1 min before'], [5, '5 min before'], [10, '10 min before']] },
  // Auto-brightness stays on at every setting; this shifts the whole curve, so the room still
  // drives the screen and there is no choice here that leaves it blinding in the dark.
  { key: 'brightness', label: 'Brightness', options: [[-2, 'Dimmest'], [-1, 'Dimmer'], [0, 'Default'], [1, 'Brighter'], [2, 'Brightest']] },
  { key: 'screenSleep', label: 'Sleep', options: [['mac', 'With Mac'], [30, 'Mac idle 30 min'], [60, 'Mac idle 1 hr'], [120, 'Mac idle 2 hr'], [240, 'Mac idle 4 hr'], ['never', 'Never']] },
  { spacer: true }, // an empty slot that sets "More settings on Mac" apart; the knob skips it
  { label: 'More settings on Mac', page: '', value: () => '' }
];
const selected = ref(0);
// Six rows fit the stage; past that the list scrolls to keep the selection in view.
const VISIBLE = 6;
const scrolled = computed(() => Math.max(0, selected.value - (VISIBLE - 1)));
const index = row => Math.max(0, row.options.findIndex(option => option[0] === state.settings[row.key]));
const value = row => row.value ? row.value(state.settings) : row.options[index(row)][1];
const screen = CT.screen('settings');
screen.show = () => { selected.value = 0; };
screen.turn = steps => {
  let next = Math.max(0, Math.min(rows.length - 1, selected.value + steps));
  if (rows[next].spacer) next = Math.max(0, Math.min(rows.length - 1, next + Math.sign(steps)));
  selected.value = next;
};
function openOnMac(section) {
  CT.send({ type: 'openSettingsPage', section });
  CT.toast('Opened on your Mac');
}
// The back button opens the settings page on the Mac, at the selected row's section if it has one.
screen.back = () => openOnMac(rows[selected.value].page || '');
screen.press = () => {
  const row = rows[selected.value];
  if (row.page != null) return openOnMac(row.page);
  const next = row.options[(index(row) + 1) % row.options.length][0];
  state.settings[row.key] = next;
  CT.send({ type: 'setting', key: row.key, value: next });
  CT.applyTheme();
};
</script>
<template>
  <section id="screen-settings" class="screen fill flex" :class="{ active: state.current === 'settings', leaving: state.leaving === 'settings' }">
    <LeftRail title="Settings" variant="instructions">
      <template #subtitle>Turn the knob to choose.<br />Press it to change.</template>
    </LeftRail>
    <ScreenStage class="bg-panel"><div class="s-list"><div class="s-rows" :style="{ transform: 'translateY(' + -scrolled * 64 + 'px)' }">
      <template v-for="(row, i) in rows" :key="i"><div v-if="row.spacer" class="s-row s-spacer" /><SettingsRow v-else :label="row.label" :value="value(row)" :selected="selected === i" :link="row.page != null" /></template>
    </div></div></ScreenStage>
  </section>
</template>
