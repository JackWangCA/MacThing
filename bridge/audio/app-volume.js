import { execFile } from 'node:child_process';
import { log } from '../log.js';

/**
 * An app's own volume slider over AppleScript (`sound volume`, 0–100), for the knob when it's
 * set to turn Spotify or Music — or, under 'auto', when the Mac's output has no volume of its
 * own (an HDMI or DisplayPort monitor). Never launches the app: a quit app reads as notRunning.
 *
 * One osascript at a time: while one is running, newer targets just replace the pending one,
 * so spinning the knob fast costs a couple of ~0.1s runs rather than a queue of them.
 * The first run makes macOS ask whether the bridge ("node") may control the app (Automation).
 */
export const APP_VOLUME = {
  'com.spotify.client': { name: 'Spotify', appleScriptName: 'Spotify', offByOne: true },
  'com.apple.Music': { name: 'Apple Music', appleScriptName: 'Music' },
};

// Spotify reads back one less than it was set to (set 58 → 57), except at 0 and 100. Asking for
// one more lands on the value we meant.
const spotifySetValue = (n) => (n <= 0 ? 0 : n >= 99 ? 100 : n + 1);

function script(app, setTo) {
  const name = app.appleScriptName;
  return [
    `if application "${name}" is running then`,
    `  tell application "${name}"`,
    ...(setTo == null ? [] : [`    set sound volume to ${setTo}`]),
    '    return sound volume',
    '  end tell',
    'else',
    '  return -1',
    'end if',
  ].join('\n');
}

function osascript(source) {
  return new Promise((resolve) =>
    // Long timeout: the first run waits on the Automation permission prompt.
    execFile('/usr/bin/osascript', ['-e', source], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        // A run that times out is almost always macOS's Automation prompt going unanswered.
        if (err.killed) return resolve({ ok: false, timedOut: true, error: 'timed out (waiting for the Automation permission?)' });
        const text = String(stderr || '').trim();
        const code = Number((/\((-?\d+)\)\s*$/.exec(text) || [])[1]) || null;
        return resolve({ ok: false, code, error: text || `osascript exited with ${err.code}` });
      }
      const n = Number(String(stdout).trim());
      resolve(Number.isFinite(n) && n >= 0 ? { ok: true, volume: n } : { ok: false, notRunning: true });
    }),
  );
}

export class AppVolume {
  constructor() {
    this.running = null; // promise of the osascript in flight
    this.pending = null; // {bundleId, target} waiting for it
  }

  static supports(bundleId) {
    return Boolean(APP_VOLUME[bundleId]);
  }

  /** {ok, volume: 0–100} | {ok: false, notRunning} | {ok: false, code, error} */
  async read(bundleId) {
    const app = APP_VOLUME[bundleId];
    if (!app) return { ok: false, error: 'unsupported app' };
    return osascript(script(app, null));
  }

  /** Sets the app's volume (0–100). Calls made while one is running are coalesced to the last. */
  set(bundleId, target) {
    this.pending = { bundleId, target: Math.round(Math.min(100, Math.max(0, target))) };
    if (!this.running) this.running = this.#drain();
    return this.running;
  }

  async #drain() {
    let result = null;
    try {
      while (this.pending) {
        const { bundleId, target } = this.pending;
        this.pending = null;
        const app = APP_VOLUME[bundleId];
        if (!app) continue;
        result = await osascript(script(app, app.offByOne ? spotifySetValue(target) : target));
        if (!result.ok && !result.notRunning) log.warn(`[volume] setting ${app.name}'s volume failed:`, result.error);
      }
    } finally {
      this.running = null;
    }
    return result;
  }
}
