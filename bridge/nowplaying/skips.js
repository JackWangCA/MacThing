// Skips made on the Mac (the keyboard's track keys, the Music or Spotify window, AirPods,
// Control Center…), worked out from Now Playing changes, so the Car Thing can show them as it
// does its own. Nothing reports the press itself, so:
// - A new track before the old one reached its end is a skip: 'previous' if it's the track that
//   played before it (going back), otherwise 'next'. A track that plays out to its end isn't a skip, and neither
//   is a track with no known length (a stream), or another app taking over.
// - The same track jumping back to its start from a few seconds in is 'previous' (what previous
//   does past the first few seconds). Dragging the playhead back to the start reads the same way.

export const END_SLACK_S = 3; // this close to its end, a track was playing out, not skipped
export const RESTART_FROM_S = 4; // a jump back to the start from at least this far in is 'previous'
export const START_S = 2; // "back at the start": under this
// A new track's position can come a moment after its title, the old track's still standing in until
// then: its arrival isn't a restart.
export const SETTLE_MS = 1500;

const idOf = (np) => (np.active ? [np.bundleId, np.title, np.artist, np.album].join('|') : '');

/** Where playback had got to at `now` (ms), from a snapshot's last reading; null if unknown. */
export function positionAt(np, now) {
  if (np.elapsed == null) return null;
  const at = np.elapsed + ((now - (np.elapsedAt ?? now)) / 1000) * (np.rate || 0);
  return Math.max(0, np.duration ? Math.min(np.duration, at) : at);
}

export class SkipDetector {
  constructor() {
    this.last = null; // the previous snapshot
    this.history = []; // the tracks played before this one, latest last: going back walks down it
    this.changedAt = -Infinity; // when the track last changed
  }

  /** Takes each Now Playing snapshot in turn. Returns 'next', 'previous' or null. */
  observe(np, now = Date.now()) {
    const last = this.last;
    this.last = np;
    const changed = idOf(last || {}) !== idOf(np);
    const back = changed && np.active && this.history[this.history.length - 1] === idOf(np);
    if (changed) {
      this.changedAt = now;
      if (back) this.history.pop();
      else if (last && last.active) this.history = this.history.slice(-19).concat(idOf(last));
    }
    if (!last || !last.active || !np.active || last.bundleId !== np.bundleId) return null;
    const was = positionAt(last, now);
    if (changed) {
      if (!last.duration || was == null || was >= last.duration - END_SLACK_S) return null; // played out
      return back ? 'previous' : 'next';
    }
    if (now - this.changedAt < SETTLE_MS) return null;
    const is = positionAt(np, now);
    if (was == null || is == null) return null;
    if (last.duration && was >= last.duration - END_SLACK_S) return null; // repeating the song
    return was >= RESTART_FROM_S && is < START_S ? 'previous' : null;
  }
}
