import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screenShouldBeOn } from '../bridge/screen-policy.js';

// An unremarkable moment: Mac awake, unlocked, display on, nobody touching anything.
const AWAKE = {
  manualSleep: false,
  sleepWithMac: true,
  lockScreen: 'clock',
  systemAsleep: false,
  locked: false,
  displayAsleep: false,
  sinceInput: 60 * 60 * 1000,
  wakeMs: 60 * 1000,
};
const on = (over) => screenShouldBeOn({ ...AWAKE, ...over });

test('an ordinary awake Mac keeps the screen lit', () => {
  assert.equal(on({}), true);
});

// The point of the whole thing: a lock shows something, a sleep does not.
test('a locked Mac keeps the screen lit for the lock sheet', () => {
  assert.equal(on({ locked: true }), true);
  assert.equal(on({ locked: true, lockScreen: 'playing' }), true);
});

test('a sleeping Mac takes the screen dark', () => {
  assert.equal(on({ systemAsleep: true }), false);
});

// Locking and walking away is how a Mac is normally left, so by the time it sleeps it is also
// locked. If the lock were tested first the screen would stay lit all night.
test('asleep beats locked when the Mac is both', () => {
  assert.equal(on({ systemAsleep: true, locked: true }), false);
  assert.equal(on({ systemAsleep: true, locked: true, lockScreen: 'playing' }), false);
});

test("'off' is the old behaviour: a lock is as dark as a sleep", () => {
  assert.equal(on({ locked: true, lockScreen: 'off' }), false);
});

// A locked Mac dims its display within a minute or two. The sheet has to outlast that or it
// would only ever be seen for as long as it took the Mac to give up.
test('a locked Mac stays lit after its display sleeps', () => {
  assert.equal(on({ locked: true, displayAsleep: true }), true);
  assert.equal(on({ locked: true, displayAsleep: true, lockScreen: 'off' }), false);
});

test('an unlocked Mac still follows its display, and an input still wakes it', () => {
  assert.equal(on({ displayAsleep: true }), false);
  assert.equal(on({ displayAsleep: true, sinceInput: 5000 }), true);
  assert.equal(on({ displayAsleep: true, sinceInput: 90 * 1000 }), false);
});

test('holding the sleep button wins over everything', () => {
  assert.equal(on({ manualSleep: true }), false);
  assert.equal(on({ manualSleep: true, locked: true }), false);
  assert.equal(on({ manualSleep: true, sleepWithMac: false }), false);
});

test('Sleep with Mac off keeps the screen lit through a lock', () => {
  assert.equal(on({ sleepWithMac: false, locked: true, displayAsleep: true }), true);
  // Including with the lock sheet turned off: the sheet is what's shown, not whether it's lit.
  assert.equal(on({ sleepWithMac: false, locked: true, lockScreen: 'off' }), true);
});
