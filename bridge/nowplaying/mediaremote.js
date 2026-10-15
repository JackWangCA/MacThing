import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { log } from '../log.js';
import { isBrowserPlaceholder } from './browser-art.js';

const SEND_IDS = { play: 0, pause: 1, playpause: 2, stop: 3, next: 4, previous: 5 };

/**
 * Now-playing source backed by macOS MediaRemote — the same data as Control Center's
 * Now Playing — so it covers Apple Music, Spotify, Podcasts, browsers (YouTube…) and
 * video players without per-app code.
 *
 * Since macOS 15.4 only Apple-entitled processes may read MediaRemote, so this goes
 * through ungive/mediaremote-adapter, which runs inside /usr/bin/perl.
 *
 * Any other source (e.g. an AppleScript fallback) should expose the same surface:
 * `start()`, `stop()`, a `snapshot` (see normalize), a 'change' event and `command(action)`.
 */
export class MediaRemoteSource extends EventEmitter {
  constructor(binDir) {
    super();
    this.script = path.join(binDir, 'mediaremote-adapter.pl');
    this.framework = path.join(binDir, 'MediaRemoteAdapter.framework');
    this.raw = {};
    this.snapshot = normalize({});
    this.proc = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    const proc = spawn(
      '/usr/bin/perl',
      [this.script, this.framework, 'stream', '--micros', '--debounce=40'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.proc = proc;
    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    createInterface({ input: proc.stderr }).on('line', (line) => log.warn('[mediaremote]', line));
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      log.warn(`[mediaremote] stream exited (${code}); restarting in 2s`);
      setTimeout(() => this.start(), 2000);
    });
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log.warn('[mediaremote] unparseable line', line.slice(0, 200));
      return;
    }
    if (msg.type !== 'data') return;
    if (msg.diff) {
      for (const [key, value] of Object.entries(msg.payload)) {
        if (value === null) delete this.raw[key];
        else this.raw[key] = value;
      }
    } else {
      this.raw = { ...msg.payload };
    }
    this.snapshot = normalize(this.raw);
    this.emit('change', this.snapshot);
  }

  /** @param {'play'|'pause'|'playpause'|'next'|'previous'|'stop'} action */
  command(action) {
    const id = SEND_IDS[action];
    if (id === undefined) return Promise.reject(new Error(`unknown command ${action}`));
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/perl', [this.script, this.framework, 'send', String(id)], (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }
}

/**
 * @returns {{
 *   active: boolean, playing: boolean, title: string, artist: string, album: string,
 *   duration: number|null, elapsed: number|null, elapsedAt: number, rate: number,
 *   bundleId: string|null, contentId: string|null, artwork: {key: string, mime: string, base64: string}|null
 * }} `elapsed` (seconds) was sampled at `elapsedAt` (epoch ms) and advances at `rate`.
 */
export function normalize(raw) {
  const playing = Boolean(raw.playing);
  const bundleId = raw.parentApplicationBundleIdentifier || raw.bundleIdentifier || null;
  const artworkKey = raw.artworkData
    ? createHash('sha1').update(raw.artworkData).digest('hex').slice(0, 16)
    : null;
  return {
    active: Boolean(raw.title && raw.bundleIdentifier),
    playing,
    title: raw.title || '',
    artist: raw.artist || '',
    album: raw.album || '',
    duration: raw.durationMicros > 0 ? raw.durationMicros / 1e6 : null,
    elapsed: typeof raw.elapsedTimeMicros === 'number' ? raw.elapsedTimeMicros / 1e6 : null,
    elapsedAt: raw.timestampEpochMicros ? raw.timestampEpochMicros / 1e3 : Date.now(),
    rate: playing ? (raw.playbackRate > 0 ? raw.playbackRate : 1) : 0,
    // Browsers report a helper process; the parent is the app the user recognizes.
    bundleId,
    contentId: raw.contentItemIdentifier || raw.uniqueIdentifier || null,
    artwork: raw.artworkData && !isBrowserPlaceholder(bundleId, artworkKey)
      ? {
          key: artworkKey,
          mime: raw.artworkMimeType || 'image/jpeg',
          base64: raw.artworkData,
        }
      : null,
  };
}
