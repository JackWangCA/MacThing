import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usageWatch, weatherWatch, wetSoon, heat, spendWatch, spendFires } from '../ui/src/smart-triggers.js';

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
  assert.equal(check(reading(0, T0 + 10 * MIN), T0 + 10 * MIN), ''); // fires gone
  assert.equal(check(reading(15, T0 + 15 * MIN), T0 + 15 * MIN), ''); // back too soon to count
  assert.equal(check(reading(0, T0 + 20 * MIN), T0 + 20 * MIN), '');
  assert.equal(check(reading(0, T0 + 34 * MIN), T0 + 34 * MIN), ''); // 14 minutes calm
  assert.equal(check(reading(15, T0 + 35 * MIN), T0 + 35 * MIN), ''); // still not 15
  assert.equal(check(reading(0, T0 + 40 * MIN), T0 + 40 * MIN), '');
  assert.equal(check(reading(0, T0 + 55 * MIN), T0 + 55 * MIN), ''); // 15 minutes calm: cooled off
  assert.equal(check(reading(15, T0 + 60 * MIN), T0 + 60 * MIN), 'hot'); // fires are back
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

test('usage: a Bottlerocket reading (a spend, with no session or week) is never a trigger', () => {
  const check = usageWatch();
  const reading = { status: 'ok', spent: 412.5, limit: 500, percent: 82.5 };
  assert.equal(check(reading, 0), '');
  assert.equal(check({ ...reading, spent: 499, percent: 99.8 }, 60000), '');
});

// ---- Bottlerocket spend ----------------------------------------------------------------------

const DAY = 24 * HOUR;
const MONDAY = Date.UTC(2026, 9, 19); // a Bottlerocket week starts Monday 00:00 UTC
// `percent` of a $500 weekly limit spent, `days` into the week.
const spend = (percent, days, week = 0) => [
  { status: 'ok', spent: percent * 5, limit: 500, percent, resetsAt: MONDAY + (week + 1) * 7 * DAY, updatedAt: 0 },
  MONDAY + week * 7 * DAY + days * DAY,
];

test('spend fires: on pace is calm, ahead of it is 🔥, far ahead 🔥🔥, at the limit 💀', () => {
  assert.equal(spendFires(...spend(50, 3.5)), ''); // half the money, half the week: 1.0x
  assert.equal(spendFires(...spend(60, 3.5)), '🔥'); // 1.5x
  assert.equal(spendFires(...spend(70, 3.5)), '🔥🔥'); // 2.3x
  assert.equal(spendFires(...spend(100, 3.5)), '💀');
  assert.equal(spendFires({ status: 'ok', spent: 900, limit: null, percent: null, resetsAt: MONDAY + 7 * DAY }, MONDAY + DAY), '', 'no limit, nothing to run out of');
});

test('spend: each threshold alerts once, as it is crossed', () => {
  const check = spendWatch();
  // Late in the week, where these are all on pace: only the thresholds speak.
  assert.equal(check(...spend(50, 6)), null, 'the first reading is the baseline');
  assert.equal(check(...spend(74, 6.1)), null);
  assert.deepEqual(check(...spend(76, 6.2)), { threshold: 75 });
  assert.equal(check(...spend(80, 6.3)), null, 'once');
  assert.deepEqual(check(...spend(101, 6.5)), { threshold: 100 }, 'a jump past two reports the higher');
  assert.equal(check(...spend(105, 6.6)), null);
});

test('spend: a page load never alerts for where the week already is', () => {
  const check = spendWatch();
  assert.equal(check(...spend(95, 5)), null);
  assert.equal(check(...spend(96, 5.1)), null);
  assert.deepEqual(check(...spend(100, 5.2)), { threshold: 100 }, 'but the next one still counts');
});

test('spend: the pace alerts as it gains each fire, once a week', () => {
  const check = spendWatch();
  assert.equal(check(...spend(30, 3)), null); // 0.6x
  assert.deepEqual(check(...spend(55, 3.2)), { pace: '🔥' }); // about 1.4x
  assert.equal(check(...spend(50, 3.5)), null, 'cooling off is not news');
  assert.equal(check(...spend(58, 3.6)), null, 'nor is the same fire coming back');
  assert.deepEqual(check(...spend(72, 3.7)), { pace: '🔥🔥' });
});

test("spend: no pace alert in the week's first day, when a morning's work reads as runaway", () => {
  const check = spendWatch();
  assert.equal(check(...spend(2, 0.2)), null);
  assert.equal(check(...spend(20, 0.6)), null, '20% by Monday lunchtime: hot on paper, too early to say');
  assert.deepEqual(check(...spend(30, 1.1)), { pace: '🔥🔥' }, 'by Tuesday it counts');
});

test('spend: a new week starts the alerts over', () => {
  const check = spendWatch();
  check(...spend(50, 6));
  assert.deepEqual(check(...spend(80, 6.5)), { threshold: 75 });
  assert.equal(check(...spend(5, 0.5, 1)), null);
  assert.deepEqual(check(...spend(76, 4, 1)), { threshold: 75 }, 'again, in the new week');
});

test('spend: a Claude reading (no limit) is not mistaken for spend', () => {
  const check = spendWatch();
  assert.equal(check({ status: 'ok', session: { percent: 90 }, week: { percent: 90 } }, T0), null);
});
