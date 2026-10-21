import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { log } from '../log.js';

/**
 * Mac sleep/wake, display sleep/wake and the lock screen, via native/bin/powerwatch.
 * Events: 'display' (asleep: boolean), 'lock' (locked: boolean), 'willSleep', 'didWake'.
 * After 'willSleep' the Mac waits (up to 3 s) until ack() is called, so there's time to
 * turn the Car Thing's screen off before USB suspends.
 */
export class MacPower extends EventEmitter {
  constructor(binDir) {
    super();
    this.bin = path.join(binDir, 'powerwatch');
    this.displayAsleep = false;
    this.locked = false;
    this.proc = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    const proc = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.proc = proc;
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.event === 'display') {
        this.displayAsleep = msg.asleep;
        this.emit('display', msg.asleep);
      } else if (msg.event === 'lock') {
        this.locked = msg.locked;
        this.emit('lock', msg.locked);
      } else if (msg.event === 'willSleep' || msg.event === 'didWake') {
        this.emit(msg.event);
      }
    });
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      log.warn(`[power] powerwatch exited (${code}); restarting in 2s`);
      setTimeout(() => this.start(), 2000);
    });
  }

  /** Milliseconds since the last keyboard, mouse or trackpad input on the Mac (null if unknown). */
  idleMs() {
    return new Promise((resolve) =>
      execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-k', 'HIDIdleTime'], { timeout: 5000 }, (err, out) => {
        const ns = !err && /"HIDIdleTime" = (\d+)/.exec(out);
        resolve(ns ? Number(ns[1]) / 1e6 : null);
      }),
    );
  }

  ack() {
    this.proc?.stdin.write('ack\n');
  }

  stop() {
    this.stopped = true;
    this.proc?.stdin.end();
  }
}
