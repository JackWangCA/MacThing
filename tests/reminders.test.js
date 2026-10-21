import assert from 'node:assert/strict';
import { test } from 'node:test';
import { step, dueSlot, inActiveHours, Reminders } from '../bridge/widgets/reminders.js';

const MIN = 60000;
const run = (entry, steps, every) => {
  let fired = 0;
  for (const s of steps) {
    const r = step(entry, s, every * MIN);
    entry = r.entry;
    if (r.fire) fired++;
  }
  return { entry, fired };
};
const at = (n) => Array.from({ length: n }, () => ({ dtMs: MIN, present: true }));
const away = (n) => Array.from({ length: n }, () => ({ dtMs: MIN, present: false }));

test('fires once per interval of time at the Mac', () => {
  assert.equal(run({ activeMs: 0, awayMs: 0 }, at(90), 30).fired, 3);
});

test('a short break pauses the count', () => {
  const { entry, fired } = run({ activeMs: 0, awayMs: 0 }, [...at(20), ...away(10), ...at(9)], 30);
  assert.equal(fired, 0);
  assert.equal(entry.activeMs, 29 * MIN);
});

test('a break as long as the interval starts it over', () => {
  const { entry, fired } = run({ activeMs: 0, awayMs: 0 }, [...at(25), ...away(30), ...at(10)], 30);
  assert.equal(fired, 0);
  assert.equal(entry.activeMs, 10 * MIN);
});

test('nothing piles up overnight', () => {
  assert.equal(run({ activeMs: 0, awayMs: 0 }, [...at(10), ...away(600), ...at(1)], 30).fired, 0);
});

test('only enabled reminders fire, and Show now restarts the count', async () => {
  const settings = { get: () => ({ reminders: [
    { id: 'a', text: 'Drink water', every: 15, on: true },
    { id: 'b', text: 'Stand up', every: 15, on: false },
  ] }) };
  const r = new Reminders({ settings, presence: async () => true, tickMs: MIN });
  const due = [];
  r.on('due', (x) => due.push(x.id));
  r.last = Date.now() - MIN;
  r.entries.set('a', { activeMs: 14 * MIN, awayMs: 0 });
  await r.tick();
  assert.deepEqual(due, ['a']);
  assert.ok(r.fire('a'));
  assert.deepEqual(r.entries.get('a'), { activeMs: 0, awayMs: 0 });
  assert.equal(r.fire('missing'), false);
});

const WORK = { days: [1, 2, 3, 4, 5], from: 9 * 60, to: 18 * 60 };
// Tuesday 2026-10-20 at hh:mm, local time.
const tue = (h, m = 0) => new Date(2026, 9, 20, h, m);

test('active hours: weekdays inside the hours only', () => {
  assert.ok(inActiveHours(tue(9), WORK));
  assert.ok(inActiveHours(tue(17, 59), WORK));
  assert.equal(inActiveHours(tue(18), WORK), false);
  assert.equal(inActiveHours(tue(8, 59), WORK), false);
  assert.equal(inActiveHours(new Date(2026, 9, 24, 12), WORK), false); // Saturday
  assert.ok(inActiveHours(new Date(2026, 9, 24, 3), null)); // any time
});

test('set times: the latest time that has come and not been shown', () => {
  const times = [10 * 60, 15 * 60];
  assert.equal(dueSlot(times, tue(8).getTime(), tue(9, 59)), null);
  assert.equal(dueSlot(times, tue(8).getTime(), tue(10)), tue(10).getTime());
  assert.equal(dueSlot(times, tue(10).getTime(), tue(14)), null); // 10:00 already shown
  assert.equal(dueSlot(times, tue(8).getTime(), tue(16)), tue(15).getTime()); // away all day: one card, not two
});

function harness(reminders, { activeHours = WORK, present = true } = {}) {
  let now = tue(8);
  const values = { reminders, activeHours };
  const r = new Reminders({ settings: { get: () => values }, presence: async () => present, tickMs: MIN, now: () => now });
  const due = [];
  r.on('due', (x) => due.push(x));
  r.last = now.getTime();
  return {
    r, due, values,
    async until(h, m = 0) {
      const end = tue(h, m).getTime();
      while (now.getTime() < end) { now = new Date(now.getTime() + MIN); await r.tick(); }
    },
    setPresent(v) { present = v; },
  };
}

test('every-N reminders wait for active hours', async () => {
  const h = harness([{ id: 'a', text: 'Stand up', repeat: 'every', every: 30, on: true }]);
  await h.until(9);
  assert.equal(h.due.length, 0); // 8–9 is outside the hours
  await h.until(10);
  assert.equal(h.due.length, 2); // 9:30, 10:00
});

test('a set time shows when you are back, once, and not outside active hours', async () => {
  const h = harness([
    { id: 'm', text: 'Meds', repeat: 'times', every: 45, times: [10 * 60], on: true },
    { id: 'n', text: 'Too early', repeat: 'times', every: 45, times: [7 * 60 + 30, 8 * 60 + 30], on: true },
  ]);
  h.setPresent(false);
  await h.until(10, 30);
  assert.equal(h.due.length, 0);
  h.setPresent(true);
  await h.until(12);
  assert.deepEqual(h.due.map((d) => [d.id, d.at]), [['m', tue(10).getTime()]]);
});

test('a time added after it has passed today waits for tomorrow', async () => {
  const h = harness([{ id: 'm', text: 'Meds', repeat: 'times', every: 45, times: [], on: true }]);
  await h.until(11);
  h.values.reminders = [{ ...h.values.reminders[0], times: [10 * 60] }];
  await h.until(12);
  assert.equal(h.due.length, 0);
});
