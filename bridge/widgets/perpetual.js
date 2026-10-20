import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';

// Now Playing's cover when nothing plays: after Pirijan Ketheswaran's perpetual-calendar (MIT,
// github.com/pketh/perpetual-calendar), itself after Dan Reisinger's 1987 MoMA Perpetual Wall
// Calendar. Six stencil panels, each a square with shapes cut out, stacked in a shuffled order in
// flat print colours so they show through each other: each panel takes a different one of PALETTE,
// so no two match. Everything is seeded by the day, so a cover holds all day and changes at midnight.
//
// The top panel is the big frame, so it decides how the whole cover reads. Its colour and shape
// aren't left to chance (which gives streaks, like blue on top day after day): each comes round in
// turn (see topIndex), so neither is ever the same two days running.
//
// The Mac draws it (Quick Look renders the SVG, drop shadows and all) and the device only shows
// the picture: six full-screen layers with shadow filters are too much for its Chromium to paint.
const PANELS = [
  'M2,600 L602,600 L602,0 L2,0 L2,600 Z M50.019,300 C50.019,181.908 131.911,82.956 242,56.798 L242,543.202 C131.911,517.045 50.019,418.092 50.019,300 L50.019,300 Z M362,543.202 L362,56.798 C472.089,82.956 553.98,181.908 553.98,300 C553.98,418.092 472.089,517.045 362,543.202 L362,543.202 Z',
  'M2,600 L602,600 L602,0 L2,0 L2,600 Z M242,492 L25,300 L242,108 L242,492 L242,492 Z M361.739,493 L361.739,107 L579,300 L361.739,493 L361.739,493 Z',
  'M2,600 L602,600 L602,0 L2,0 L2,600 Z M96,437 L508,437 L508,492 L96,492 L96,437 Z M96,325 L508,325 L508,380 L96,380 L96,325 Z M96,219 L508,219 L508,274 L96,274 L96,219 Z M96,107 L508,107 L508,162 L96,162 L96,107 Z',
  'M2,600 L602,600 L602,0 L2,0 L2,600 Z M579,306.627 C579,346.8 546.331,379.367 506.033,379.367 L97.967,379.367 C57.669,379.367 25,346.8 25,306.627 L25,293.108 C25,252.934 57.669,220.367 97.967,220.367 L506.033,220.367 C546.331,220.367 579,252.934 579,293.108 L579,306.627 Z',
  'M2,600 L602,600 L602,0 L2,0 L2,600 Z M52,106 L96,106 L96,496 L52,496 L52,106 Z M103,506 L493,506 L493,550 L103,550 L103,506 Z M244,300 C244,267.967 269.967,242 302,242 C334.033,242 360,267.967 360,300 C360,332.033 334.033,358 302,358 C269.967,358 244,332.033 244,300 Z M108,50 L498,50 L498,94 L108,94 L108,50 Z M508,106 L552,106 L552,496 L508,496 L508,106 Z',
  'M2,600 L602,600 L602,0 L2,0 L2,600 Z M126.248,122.239 L479,122.239 L479,474.991 L126.248,474.991 L126.248,122.239 Z',
];
// The colours of Reisinger's 1987 original, sampled from photos of the printed calendar (pketh's web
// version picks fully random ones instead): yellow, crimson, vermilion, orange, pink, blue, green and
// lime. Eight for six panels, so two different ones sit out each day.
export const PALETTE = ['#f5d90f', '#e1142b', '#ee4a22', '#f2851d', '#d8418f', '#2c78c4', '#14895b', '#a6c43a'];
export const SIZE = 480; // the stage beside the rail
// Paper: how far the fine grain and the broad mottling move each panel's colour (0…1 of full range,
// split either side of the colour). Keep them small: it should read as card, not as noise.
const GRAIN = 0.16, MOTTLE = 0.03;

/** A panel's filter: its own paper texture (each panel a different sheet, the same one every day),
 *  clipped to the panel so its holes stay clear, then the drop shadow it casts on the panels below. */
function paperFilter(i) {
  const grey = '0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 0 1'; // noise as opaque grey
  return `<filter id="paper${i}" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="${i * 2 + 1}" result="grainNoise"/>
<feColorMatrix in="grainNoise" type="matrix" values="${grey}" result="grain"/>
<feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="2" seed="${i * 2 + 2}" result="mottleNoise"/>
<feColorMatrix in="mottleNoise" type="matrix" values="${grey}" result="mottle"/>
<feComposite in="SourceGraphic" in2="grain" operator="arithmetic" k1="0" k2="1" k3="${GRAIN * 2}" k4="${-GRAIN}" result="grained"/>
<feComposite in="grained" in2="mottle" operator="arithmetic" k1="0" k2="1" k3="${MOTTLE * 2}" k4="${-MOTTLE}" result="papered"/>
<feComposite in="papered" in2="SourceGraphic" operator="in" result="panel"/>
<feDropShadow in="panel" dx="0" dy="2" stdDeviation="1" flood-color="#000" flood-opacity="0.14"/>
</filter>`;
}

/** Days since the epoch in the Mac's own timezone — the same day the device's calendar shows. */
export function localDay(ms = Date.now()) {
  return Math.floor((ms - new Date(ms).getTimezoneOffset() * 60000) / 86400000);
}

// A small seeded generator (mulberry32), so a day always draws the same cover.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shuffles `list` in place (Fisher–Yates) with the generator `next`. */
function shuffle(list, next) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** The order a run of `length` days takes its turns in: run `run`'s own shuffle of 0…length-1. */
function runOrder(run, length, salt) {
  return shuffle(Array.from({ length }, (_, i) => i), random(run * 104729 + salt));
}

/**
 * Which of `length` choices is on top on `day`. Days go in runs of `length`, and each run puts
 * every choice on top once, in its own shuffled order. A run that would open with the choice the
 * last one closed on swaps its first two, so the top never repeats across the join either. (The
 * swap only moves a run's first two days, so a run's last day never depends on the run before it.)
 */
export function topIndex(day, length, salt) {
  const run = Math.floor(day / length);
  const order = runOrder(run, length, salt);
  if (order[0] === runOrder(run - 1, length, salt)[length - 1]) [order[0], order[1]] = [order[1], order[0]];
  return order[day - run * length];
}

/** The day's cover as SVG. */
export function coverSvg(day) {
  const next = random(day * 7919);
  const topColour = topIndex(day, PALETTE.length, 1), topPanel = topIndex(day, PANELS.length, 2);
  // The other five panels, below the top one in a shuffled order, each take a different one of
  // the colours left.
  const colours = shuffle(PALETTE.filter((_, i) => i !== topColour), next);
  const below = shuffle(PANELS.filter((_, i) => i !== topPanel), next);
  const panels = below.map((d, i) => ({ d, fill: colours[i] })).concat({ d: PANELS[topPanel], fill: PALETTE[topColour] })
    .map((p) => ({ ...p, paper: PANELS.indexOf(p.d) }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="2 0 600 600">
<defs>${PANELS.map((_, i) => paperFilter(i)).join('\n')}</defs>
<rect x="2" y="0" width="600" height="600" fill="#000"/>
${panels.map((p) => `<path d="${p.d}" fill="${p.fill}" fill-rule="evenodd" filter="url(#paper${p.paper})"/>`).join('\n')}
</svg>`;
}

const run = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, { timeout: 15000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));

/** Renders the day's cover to a PNG with Quick Look (qlmanage ships with every Mac). */
export async function renderCover(day, dir) {
  const svg = path.join(dir, `cover-${day}.svg`);
  const png = svg + '.png'; // qlmanage names its thumbnail after the source
  try {
    await fs.writeFile(svg, coverSvg(day));
    await run('/usr/bin/qlmanage', ['-t', '-s', String(SIZE), '-o', dir, svg]);
    return await fs.readFile(png);
  } finally {
    fs.rm(svg, { force: true }).catch(() => {});
    fs.rm(png, { force: true }).catch(() => {});
  }
}

/**
 * Today's cover for the device. `state` is { status: 'ok', day, dataUrl, blurUrl?, tint? } or
 * { status: 'loading' | 'error' }. The cover is run through native/bin/artwork like album art:
 * dataUrl is the cover as its JPEG (the paper grain makes a PNG of it ten times the size), or the
 * PNG if that fails. With `blur`, blurUrl is the album art background used while nothing plays,
 * already blurred, and tint how strong a tint each theme needs over it.
 * Checks each minute for a new day (a timer set for midnight would fire late after the Mac sleeps
 * through it).
 */
export class PerpetualCover extends EventEmitter {
  constructor(artworkBin, { blur = false } = {}) {
    super();
    this.artworkBin = artworkBin;
    this.blur = blur;
    this.state = { status: 'loading' };
    this.dir = null;
    this.seq = 0;
  }

  start() {
    this.refresh();
    setInterval(() => {
      if (this.state.day !== localDay()) this.refresh(); // a new day, or the last try failed
    }, 60 * 1000);
  }

  async refresh() {
    const day = localDay(), seq = ++this.seq;
    try {
      this.dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'carthing-perpetual-'));
      const png = await renderCover(day, this.dir);
      const encoded = await this.#encode(png, day).catch((err) => log.warn('[perpetual] sending the PNG:', err.message));
      if (seq !== this.seq) return; // a newer try started meanwhile
      this.#set({
        status: 'ok',
        day,
        dataUrl: encoded ? `data:image/jpeg;base64,${encoded.cover.toString('base64')}` : `data:image/png;base64,${png.toString('base64')}`,
        ...(encoded?.background && { blurUrl: `data:image/jpeg;base64,${encoded.background.toString('base64')}`, tint: encoded.tint }),
      });
    } catch (err) {
      log.warn('[perpetual] could not draw the cover', err.message);
      if (this.state.status !== 'ok') this.#set({ status: 'error' });
    }
  }

  /** The cover as a JPEG and, with `blur`, its album art background, both made as album art's are. */
  async #encode(png, day) {
    const src = path.join(this.dir, `cover-${day}.png`);
    const cover = path.join(this.dir, `cover-${day}.jpg`);
    const blur = path.join(this.dir, `cover-${day}.blur.jpg`);
    try {
      await fs.writeFile(src, png);
      const { tint } = JSON.parse(await run(this.artworkBin, [src, String(SIZE), cover, ...(this.blur ? [blur] : [])]));
      const background = this.blur ? await fs.readFile(blur).catch(() => null) : null;
      return { cover: await fs.readFile(cover), background, tint };
    } finally {
      for (const f of [src, cover, blur]) fs.rm(f, { force: true }).catch(() => {});
    }
  }

  #set(state) {
    this.state = state;
    this.emit('change', state);
  }
}
