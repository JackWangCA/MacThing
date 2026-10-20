import assert from 'node:assert/strict';
import { test } from 'node:test';
import { step, Reminders } from '../bridge/widgets/reminders.js';

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
