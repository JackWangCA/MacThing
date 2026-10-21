import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Weather } from '../bridge/widgets/weather.js';

// The forecast itself is not what these tests are about: the place name is decided before the
// fetch, so letting it fail exercises the naming without a network or a full Open-Meteo payload.
global.fetch = async () => {
  throw new Error('offline (test)');
};

const PALO_ALTO = { ok: true, lat: 37.44, lon: -122.14 };

function weatherWith(replies) {
  const queue = [...replies];
  const helper = { location: async () => queue.shift() };
  const settings = { get: () => ({ location: { mode: 'auto' }, units: 'C' }), on: () => {} };
  return new Weather(helper, settings);
}

// Each refresh re-asks only once the 30-minute cache is up; the tests are not waiting that out.
async function refreshAgain(weather) {
  weather.auto.at = 0;
  await weather.refresh();
}

test('a located fix is named by the reverse geocode', async () => {
  const weather = weatherWith([{ ...PALO_ALTO, name: 'Palo Alto' }]);
  await weather.refresh();
  assert.equal(weather.auto.name, 'Palo Alto');
});

test('an unnamed reply for the same spot keeps the name already resolved', async () => {
  const weather = weatherWith([
    { ...PALO_ALTO, name: 'Palo Alto' },
    { ...PALO_ALTO, name: '' }, // the helper's 20s deadline expired with the geocode still out
  ]);
  await weather.refresh();
  await refreshAgain(weather);
  assert.equal(weather.auto.name, 'Palo Alto', 'a timed-out geocode must not rename a known place');
});

test('an unnamed reply somewhere else does not carry the old name along', async () => {
  const weather = weatherWith([
    { ...PALO_ALTO, name: 'Palo Alto' },
    { ok: true, lat: 34.05, lon: -118.24, name: '' },
  ]);
  await weather.refresh();
  await refreshAgain(weather);
  assert.equal(weather.auto.name, 'Current location');
});

test('a fix that drifts within a few km is still the same place', async () => {
  const weather = weatherWith([
    { ...PALO_ALTO, name: 'Palo Alto' },
    { ok: true, lat: 37.46, lon: -122.17, name: '' }, // cell/wifi accuracy, not the next town
  ]);
  await weather.refresh();
  await refreshAgain(weather);
  assert.equal(weather.auto.name, 'Palo Alto');
});

test('with nothing resolved yet an unnamed reply uses the fallback', async () => {
  const weather = weatherWith([{ ...PALO_ALTO, name: '' }]);
  await weather.refresh();
  assert.equal(weather.auto.name, 'Current location');
});

test('a name arriving later replaces the fallback', async () => {
  const weather = weatherWith([
    { ...PALO_ALTO, name: '' },
    { ...PALO_ALTO, name: 'Palo Alto' },
  ]);
  await weather.refresh();
  await refreshAgain(weather);
  assert.equal(weather.auto.name, 'Palo Alto');
});

// A helper only geocodes on its first location request, so an unnamed reply means this one is
// spent: the fix behind it is as old as the geocode it could not finish, and no later request
// will do better. These cover trading it for a new one rather than living with the stale answer.
function weatherWithRecycle(replies, { fails = false } = {}) {
  const queue = [...replies];
  const calls = { located: 0, recycled: 0 };
  const helper = {
    location: async () => {
      calls.located++;
      return queue.shift();
    },
    recycle: async () => {
      calls.recycled++;
      return !fails;
    },
  };
  const settings = { get: () => ({ location: { mode: 'auto' }, units: 'C' }), on: () => {} };
  return { weather: new Weather(helper, settings), calls };
}

test('an unnamed reply trades the helper in and asks the new one', async () => {
  const { weather, calls } = weatherWithRecycle([
    { ...PALO_ALTO, name: '' },
    { ok: true, lat: 34.05, lon: -118.24, name: 'Los Angeles' },
  ]);
  await weather.refresh();
  assert.equal(calls.recycled, 1);
  assert.equal(weather.auto.name, 'Los Angeles', 'the fresh fix is the one that counts');
  assert.equal(weather.auto.lat, 34.05, 'and its coordinates come with it');
});

test('a named reply is taken at its word', async () => {
  const { weather, calls } = weatherWithRecycle([{ ...PALO_ALTO, name: 'Palo Alto' }]);
  await weather.refresh();
  assert.equal(calls.recycled, 0, 'nothing to fix, so nothing to restart');
  assert.equal(calls.located, 1);
});

test('a helper that will not come back leaves the first reply standing', async () => {
  const { weather, calls } = weatherWithRecycle([{ ...PALO_ALTO, name: '' }], { fails: true });
  await weather.refresh();
  assert.equal(calls.recycled, 1);
  assert.equal(calls.located, 1, 'no second ask when there is nothing new to ask');
  assert.equal(weather.auto.name, 'Current location');
  assert.equal(weather.auto.lat, PALO_ALTO.lat, 'the stale fix still beats no fix');
});

test('a new helper with no name either is not traded in again', async () => {
  const { weather, calls } = weatherWithRecycle([
    { ...PALO_ALTO, name: '' },
    { ...PALO_ALTO, name: '' },
    { ...PALO_ALTO, name: '' },
  ]);
  await weather.refresh();
  await refreshAgain(weather);
  assert.equal(calls.recycled, 1, 'the cooldown stops a geocode that is simply down from looping');
  assert.equal(calls.located, 3);
});
