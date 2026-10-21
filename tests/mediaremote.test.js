import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaRemoteSource } from '../bridge/nowplaying/mediaremote.js';

/** Where the bridge would say playback is, the same sum nowPlayingMessage() does. */
const positionAt = (snapshot, now) =>
  snapshot.elapsed == null
    ? null
    : snapshot.elapsed + ((now - snapshot.elapsedAt) / 1000) * snapshot.rate;

/**
 * A real pause, captured off the MediaRemote stream (Apple Music, "Glorious"). The track began
 * at 0:00 and nothing further was reported for 26 seconds — MediaRemote sends a position only
 * when playback changes state — and then the pause arrived as two messages, the first with no
 * position in it at all.
 */
const START_MICROS = 1792520287213449;
const PAUSE_MICROS = 1792520313388453;
const CAPTURE = [
  { diff: false, payload: { title: 'Glorious (feat. Skylar Grey)', artist: 'Macklemore', album: 'GEMINI', bundleIdentifier: 'com.apple.Music', playing: true, playbackRate: 1, elapsedTimeMicros: 1, durationMicros: 220502000, timestampEpochMicros: START_MICROS } },
  { diff: true, payload: { playing: false } },
  { diff: true, payload: { playbackRate: 0, elapsedTimeMicros: 25977510, timestampEpochMicros: PAUSE_MICROS } },
];

function replay(lines, clock) {
  const source = new MediaRemoteSource('/nowhere');
  const positions = [];
  for (const line of lines) {
    source.onLine(JSON.stringify({ type: 'data', ...line }));
    positions.push(positionAt(source.snapshot, clock()));
  }
  return { source, positions };
}

test('a pause announced without a position does not rewind the bar', () => {
  // The pause lands 26.175s into the track, which is where the clock is held for the replay.
  const now = PAUSE_MICROS / 1e3;
  const realDate = Date.now;
  Date.now = () => now;
  try {
    const { source, positions } = replay(CAPTURE, () => now);
    const [started, announced, confirmed] = positions;

    assert.equal(Math.round(started), 26, 'before the pause, 26s in and still counting');
    // Without the re-anchor this read 0.00s — the position from 26 seconds earlier, which is
    // all "{playing:false}" leaves behind.
    assert.ok(
      Math.abs(announced - 26.175) < 0.05,
      `"{playing:false}" alone must hold where playback reached (got ${announced?.toFixed(2)}s)`,
    );
    assert.ok(Math.abs(confirmed - 25.977) < 0.01, 'and the position Music then sends is honoured');

    // Music's own pause position is a fraction behind where the bridge had got to, because the
    // pause took effect just before the message describing it. Small enough that the device's
    // drift clamp (ui/src/state.js, 1.5s) swallows the correction instead of drawing it.
    assert.ok(
      announced - confirmed > 0 && announced - confirmed < 0.5,
      `the leftover correction must stay under the device's clamp (was ${(announced - confirmed).toFixed(2)}s)`,
    );
    // The symptom, stated as the rule it broke: no lurch backwards across a pause.
    for (let i = 1; i < positions.length; i++) {
      assert.ok(
        positions[i] >= positions[i - 1] - 0.5,
        `step ${i} went backwards: ${positions[i - 1]?.toFixed(2)}s → ${positions[i]?.toFixed(2)}s`,
      );
    }
    assert.equal(source.snapshot.rate, 0, 'and it really is paused');
    assert.equal(source.snapshot.duration, 220.502, 'with the bar still knowing how long the song is');
  } finally {
    Date.now = realDate;
  }
});

test('a position that comes with the state change is taken as sent', () => {
  const now = PAUSE_MICROS / 1e3;
  const realDate = Date.now;
  Date.now = () => now;
  try {
    // A seek backwards while playing: a real move, and not one to be smoothed away.
    const { source } = replay([
      CAPTURE[0],
      { diff: true, payload: { playing: true, playbackRate: 1, elapsedTimeMicros: 5_000_000, timestampEpochMicros: PAUSE_MICROS } },
    ], () => now);
    assert.equal(source.snapshot.elapsed, 5);
  } finally {
    Date.now = realDate;
  }
});

test('resuming does not count the pause as music that was played', () => {
  const realDate = Date.now;
  let now = PAUSE_MICROS / 1e3;
  Date.now = () => now;
  try {
    const source = new MediaRemoteSource('/nowhere');
    for (const line of CAPTURE) source.onLine(JSON.stringify({ type: 'data', ...line }));
    const paused = positionAt(source.snapshot, now);

    now += 30_000; // half a minute sitting paused
    assert.equal(positionAt(source.snapshot, now), paused, 'a pause holds, however long it lasts');

    // Resume arrives the same way a pause does: the state first, the position a moment later.
    source.onLine(JSON.stringify({ type: 'data', diff: true, payload: { playing: true } }));
    const resumed = positionAt(source.snapshot, now);
    assert.equal(source.snapshot.rate, 1);
    assert.ok(
      Math.abs(resumed - paused) < 0.01,
      `playback must restart from where it stopped, not ${(resumed - paused).toFixed(1)}s later`,
    );
  } finally {
    Date.now = realDate;
  }
});
