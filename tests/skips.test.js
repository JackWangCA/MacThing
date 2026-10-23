import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SkipDetector } from '../bridge/nowplaying/skips.js';

const MUSIC = 'com.apple.Music';
// A snapshot of `title` playing, `elapsed` seconds in as of `at` (ms).
const track = (title, elapsed, at, extra = {}) => ({
  active: true, playing: true, bundleId: MUSIC, title, artist: 'Ovlov', album: 'Buds',
  duration: 200, elapsed, elapsedAt: at, rate: 1, ...extra,
});

test('a new track mid-song is a skip to the next one', () => {
  const d = new SkipDetector();
  assert.equal(d.observe(track('A', 0, 0), 0), null);
  assert.equal(d.observe(track('B', 0, 60000), 60000), 'next');
});

test('a track that plays out to its end is not a skip', () => {
  const d = new SkipDetector();
  d.observe(track('A', 0, 0), 0);
  assert.equal(d.observe(track('B', 0, 199000), 199000), null);
});

test('going back to the track before is previous, and forward again is next', () => {
  const d = new SkipDetector();
  d.observe(track('A', 0, 0), 0);
  assert.equal(d.observe(track('B', 0, 30000), 30000), 'next');
  assert.equal(d.observe(track('A', 0, 31000), 31000), 'previous');
  assert.equal(d.observe(track('B', 0, 40000), 40000), 'next');
  assert.equal(d.observe(track('A', 0, 41000), 41000), 'previous');
});

test('the same track jumping back to its start is previous', () => {
  const d = new SkipDetector();
  d.observe(track('A', 0, 0), 0);
  assert.equal(d.observe(track('A', 0, 30000), 30000), 'previous');
});

test('a pause or resume is nothing', () => {
  const d = new SkipDetector();
  d.observe(track('A', 0, 0), 0);
  assert.equal(d.observe(track('A', 30, 30000, { playing: false, rate: 0 }), 30000), null);
  assert.equal(d.observe(track('A', 30, 50000), 50000), null);
});

test("a new track's position arriving after its title is not also a restart", () => {
  const d = new SkipDetector();
  d.observe(track('A', 0, 0), 0);
  assert.equal(d.observe(track('B', 0, 0), 60000), 'next'); // title first, old reading still there
  assert.equal(d.observe(track('B', 0, 60100), 60100), null);
});

test('repeating a song is not previous', () => {
  const d = new SkipDetector();
  d.observe(track('A', 0, 0), 0);
  assert.equal(d.observe(track('A', 0, 200500), 200500), null);
});

test('another app taking over, or a stream with no length, is not a skip', () => {
  const d = new SkipDetector();
  d.observe(track('A', 0, 0), 0);
  assert.equal(d.observe(track('Video', 0, 30000, { bundleId: 'com.google.Chrome' }), 30000), null);
  const radio = new SkipDetector();
  radio.observe(track('Song 1', 0, 0, { duration: 0 }), 0);
  assert.equal(radio.observe(track('Song 2', 0, 30000, { duration: 0 }), 30000), null);
});

test('starting from nothing playing is not a skip', () => {
  const d = new SkipDetector();
  d.observe({ active: false }, 0);
  assert.equal(d.observe(track('A', 0, 1000), 1000), null);
});
