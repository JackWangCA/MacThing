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

/**
 * Every hop here sits 0.04° (~4 km) beyond the one before it, so each one on its own passes the
 * 5 km check against its immediate predecessor. If the check were made against the last fix, an
 * unnamed fix would inherit the name and then become the anchor for the next, re-centring the
 * circle on its own edge each time: five hops end ~22 km from Palo Alto with the label intact,
 * and no single step ever looks wrong. Anchoring to where the geocode resolved instead, the
 * second hop is already 0.08° out and the name is given up.
 */
test('an inherited name does not become the anchor, so it cannot walk', async () => {
  const walk = [0.04, 0.08, 0.12, 0.16, 0.2].map((d) => ({
    ok: true, lat: PALO_ALTO.lat + d, lon: PALO_ALTO.lon, name: '',
  }));
  const weather = weatherWith([{ ...PALO_ALTO, name: 'Palo Alto' }, ...walk]);
  await weather.refresh();
  assert.equal(weather.auto.name, 'Palo Alto', 'the geocode names the starting point');

  const names = [];
  for (let i = 0; i < walk.length; i++) {
    await refreshAgain(weather);
    names.push(weather.auto.name);
  }
  assert.deepEqual(
    names,
    ['Palo Alto', 'Current location', 'Current location', 'Current location', 'Current location'],
    `the name must stop at the circle round where it resolved rather than travelling along (got ${names.join(' → ')})`,
  );
});

test('and returning to the named spot picks the name back up', async () => {
  const weather = weatherWith([
    { ...PALO_ALTO, name: 'Palo Alto' },
    { ok: true, lat: 34.05, lon: -118.24, name: '' }, // away, and unnamed
    { ...PALO_ALTO, name: '' }, // back, still unnamed
  ]);
  await weather.refresh();
  await refreshAgain(weather);
  assert.equal(weather.auto.name, 'Current location');
  await refreshAgain(weather);
  assert.equal(weather.auto.name, 'Palo Alto', 'the anchor outlives a trip away from it');
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
