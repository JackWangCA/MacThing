import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usageWatch, weatherWatch, wetSoon, heat } from '../ui/src/smart-triggers.js';

const HOUR = 3600000, MIN = 60000;
const T0 = Date.UTC(2026, 9, 23, 12);
// A session that resets at `resetsAt` with `percent` used.
const usage = (percent, resetsAt, weekPercent = 10, weekResets = T0 + 3 * 24 * HOUR) =>
  ({ status: 'ok', session: { percent, resetsAt }, week: { percent: weekPercent, resetsAt: weekResets } });

test('heat follows the fires: 🔥 above 1.0x, 🔥🔥 from 2x, 💀 at the limit', () => {
  const half = T0 + 2.5 * HOUR; // halfway through the session
  assert.equal(heat(usage(50, half), T0), 0); // 1.0x
  assert.equal(heat(usage(55, half), T0), 1); // 1.2x
  assert.equal(heat(usage(67, half), T0), 2); // 2x
  assert.equal(heat(usage(100, half), T0), 3);
});

test('heat: a hot burn right now beats a calm average, while it is fresh', () => {
  const half = T0 + 2.5 * HOUR;
  const burning = (percent, updatedAt) => ({ ...usage(30, half), updatedAt,
    session: { percent: 30, resetsAt: half, burn: { percent, ms: 15 * MIN } } });
  assert.equal(heat(burning(15, T0), T0), 2); // 15% in 15 minutes: about 2.1x
  assert.equal(heat(burning(10, T0), T0), 1); // about 1.4x
  assert.equal(heat(burning(15, T0 - 30 * MIN), T0), 0); // too old: the 0.4x average
});

test('usage: a burn heating up switches, even on a calm session', () => {
  const check = usageWatch();
  const half = T0 + 2.5 * HOUR;
  const reading = (burn, at) => ({ ...usage(30, half), updatedAt: at,
    session: { percent: 30, resetsAt: half, burn: burn && { percent: burn, ms: 15 * MIN } } });
  assert.equal(check(reading(0, T0), T0), '');
  assert.equal(check(reading(15, T0 + 5 * MIN), T0 + 5 * MIN), 'hot');
  assert.equal(check(reading(0, T0 + 10 * MIN), T0 + 10 * MIN), ''); // cooled off
  assert.equal(check(reading(15, T0 + 15 * MIN), T0 + 15 * MIN), ''); // already had two fires this session
});

test('usage: the first reading is only a baseline, even when hot', () => {
  const check = usageWatch();
  const resets = T0 + 4 * HOUR; // an hour into the session
  assert.equal(check(usage(80, resets), T0), ''); // way over 4x, but just loaded
});

test('usage: switches once for each new fire as the pace climbs', () => {
  const check = usageWatch();
  const resets = T0 + 2.5 * HOUR; // halfway through the session
  assert.equal(check(usage(40, resets), T0), ''); // under 1x
  assert.equal(check(usage(55, resets), T0 + 5 * MIN), 'hot'); // 🔥
  assert.equal(check(usage(70, resets), T0 + 10 * MIN), 'hot'); // 🔥🔥
  assert.equal(check(usage(72, resets), T0 + 15 * MIN), ''); // still 🔥🔥
  assert.equal(check(usage(100, resets), T0 + 20 * MIN), 'hot'); // the limit
  assert.equal(check(usage(100, resets), T0 + 25 * MIN), '');
});

test('usage: a well-used session resetting fires once, when its time runs out', () => {
  const check = usageWatch();
  const resets = T0 + 10 * MIN;
  check(usage(90, resets), T0);
  assert.equal(check(usage(90, resets), resets - 1000), '');
  assert.equal(check(usage(90, resets), resets), 'reset'); // before the Mac has a new reading
  assert.equal(check(usage(0, null), resets + 5 * MIN), '');
  assert.equal(check(usage(0, null), resets + 10 * MIN), '');
});

test('usage: a lightly used session resetting does nothing', () => {
  const check = usageWatch();
  const resets = T0 + 10 * MIN;
  check(usage(70, resets), T0);
  assert.equal(check(usage(70, resets), resets + 1000), '');
});

test('usage: a well-used week resetting fires', () => {
  const check = usageWatch();
  const weekEnds = T0 + 30 * MIN;
  check(usage(5, T0 + 4 * HOUR, 95, weekEnds), T0);
  assert.equal(check(usage(5, T0 + 4 * HOUR, 95, weekEnds), weekEnds + 1000), 'reset');
});

test('usage: a new session starts its tiers again', () => {
  const check = usageWatch();
  const first = T0 + 2.5 * HOUR;
  check(usage(40, first), T0);
  assert.equal(check(usage(85, first), T0 + 5 * MIN), 'hot');
  const second = first + 5 * HOUR, start = first + 1;
  assert.equal(check(usage(0, null), start), 'reset'); // it ended at 85%
  assert.equal(check(usage(60, second), start + 2.5 * HOUR), 'hot'); // 1.5x: 🔥 again
});

const hour = (t, code, pop) => ({ t, code, pop, temp: 50, isDay: true });
const weather = (currentCode, hourly) => ({ status: 'ok', current: { code: currentCode }, hourly });

test('weather: rain due next hour counts, rain already falling does not', () => {
  const now = T0 + 20 * MIN;
  const rainNext = [hour(T0, 2, 10), hour(T0 + HOUR, 61, 70), hour(T0 + 2 * HOUR, 61, 80)];
  assert.equal(wetSoon(weather(2, rainNext), now), true);
  assert.equal(wetSoon(weather(63, rainNext), now), false);
  assert.equal(wetSoon(weather(2, [hour(T0, 2, 10), hour(T0 + HOUR, 61, 30)]), now), false); // unlikely
  assert.equal(wetSoon(weather(2, [hour(T0, 2, 10), hour(T0 + HOUR, 2, 0), hour(T0 + 2 * HOUR, 73, 90)]), now), false); // too far off
  assert.equal(wetSoon(weather(1, [hour(T0, 2, 10), hour(T0 + HOUR, 71, 60)]), now), true); // snow
});

test('weather: fires when rain becomes due, once, and not on the first reading', () => {
  const check = weatherWatch();
  const dry = weather(2, [hour(T0, 2, 10), hour(T0 + HOUR, 2, 10)]);
  const wet = weather(2, [hour(T0, 2, 10), hour(T0 + HOUR, 61, 70)]);
  assert.equal(weatherWatch()(wet, T0), false); // already due at load
  assert.equal(check(dry, T0), false);
  assert.equal(check(wet, T0 + 15 * MIN), true);
  assert.equal(check(wet, T0 + 30 * MIN), false);
  assert.equal(check(dry, T0 + 45 * MIN), false);
  assert.equal(check(wet, T0 + 50 * MIN), true);
});
