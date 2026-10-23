import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usageWatch, weatherWatch, wetSoon, paceTier } from '../ui/src/smart-triggers.js';

const HOUR = 3600000, MIN = 60000;
const T0 = Date.UTC(2026, 9, 23, 12);
// A session that resets at `resetsAt` with `percent` used.
const usage = (percent, resetsAt, weekPercent = 10, weekResets = T0 + 3 * 24 * HOUR) =>
  ({ status: 'ok', session: { percent, resetsAt }, week: { percent: weekPercent, resetsAt: weekResets } });

test('pace tiers: 2x, 4x and the limit', () => {
  assert.deepEqual([1.9, 2, 3.9, 4, 12, Infinity].map(paceTier), [0, 1, 1, 2, 2, 3]);
});

test('usage: the first reading is only a baseline, even when hot', () => {
  const check = usageWatch();
  const resets = T0 + 4 * HOUR; // an hour into the session
  assert.equal(check(usage(80, resets), T0), ''); // way over 4x, but just loaded
});

test('usage: fires once per tier as the pace climbs', () => {
  const check = usageWatch();
  const resets = T0 + 2.5 * HOUR; // halfway through the session
  assert.equal(check(usage(40, resets), T0), ''); // under 1x
  assert.equal(check(usage(70, resets), T0 + 5 * MIN), 'hot'); // about 2.5x
  assert.equal(check(usage(72, resets), T0 + 10 * MIN), ''); // same tier
  assert.equal(check(usage(85, resets), T0 + 15 * MIN), 'hot'); // past 4x
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
  assert.equal(check(usage(60, second), start + 2.5 * HOUR), ''); // 1.5x
  assert.equal(check(usage(70, second), start + 2.5 * HOUR), 'hot'); // about 2.3x
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
