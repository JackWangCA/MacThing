import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { log } from '../log.js';

/**
 * System output volume via the long-running native/bin/MacThingVolume helper (CoreAudio).
 * Emits 'change' with {volume: 0..1|null, muted, supported, device} — including changes
 * made on the Mac itself (keyboard volume keys, switching to AirPods, …).
 */
export class Volume extends EventEmitter {
  constructor(binDir) {
    super();
    this.bin = path.join(binDir, 'MacThingVolume');
    this.state = null;
    this.proc = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    const proc = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.proc = proc;
    createInterface({ input: proc.stdout }).on('line', (line) => {
      try {
        this.state = JSON.parse(line);
        this.emit('change', this.state);
      } catch {
        log.warn('[volume] unparseable line', line);
      }
    });
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      log.warn(`[volume] helper exited (${code}); restarting in 2s`);
      setTimeout(() => this.start(), 2000);
    });
  }

  stop() {
    this.stopped = true;
    this.proc?.stdin.end();
  }

  #write(line) {
    this.proc?.stdin.write(`${line}\n`);
  }

  delta(d) {
    if (Number.isFinite(d) && d !== 0) this.#write(`delta ${d.toFixed(4)}`);
  }

  set(v) {
    if (Number.isFinite(v)) this.#write(`set ${Math.min(1, Math.max(0, v)).toFixed(4)}`);
  }

  toggleMute() {
    this.#write('togglemute');
  }

  /** Presses the Mac's volume key (fine = 1/64 step); macOS shows its volume indicator. */
  pressKey(up, { fine = true } = {}) {
    this.#write(`key ${up ? 'up' : 'down'}${fine ? ' fine' : ''}`);
  }

  /** Shows macOS's one-time prompt for the Accessibility permission pressKey needs. */
  requestKeyAccess() {
    this.#write('requestaccess');
  }
}
