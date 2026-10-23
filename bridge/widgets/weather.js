import { EventEmitter } from 'node:events';
import { log } from '../log.js';

const REFRESH_MS = 15 * 60 * 1000;
const RELOCATE_MS = 30 * 60 * 1000;
// How far a new fix may sit from the last named one and still be called the same place. 0.05° is
// roughly 5 km, which covers a fix wandering between cell and wifi accuracy without covering the
// next town along.
const NEARBY_DEG = 0.05;
// Asking again from the device (the weather button while the weather is unavailable): each try
// that fails doubles the wait before the next is allowed, 4 s, 8 s, 16 s… up to 5 minutes.
const RETRY_FIRST_MS = 4000;
const RETRY_MAX_MS = 5 * 60 * 1000;

/**
 * Weather for the device's Weather screen, from Open-Meteo (free, no API key).
 * Location is the Mac's (via CarThingHelper / Location Services) unless the user set one
 * manually in settings. Coordinates are rounded to ~1 km before leaving the Mac.
 *
 * `state` is one of:
 *   { status: 'ok', place, source, units, utcOffset, current, today, hourly[], daily[], updatedAt }
 *   { status: 'noLocation', reason }   location permission denied/unavailable and no manual place
 *   { status: 'error', message }       and no earlier data to fall back on
 *   { status: 'loading' }
 */
export class Weather extends EventEmitter {
  constructor(helper, settings) {
    super();
    this.helper = helper;
    this.settings = settings;
    this.state = { status: 'loading' };
    this.auto = null; // last Mac-located position
    this.named = null; // {name, lat, lon}: where a geocode last actually resolved a name
    this.inflight = null;
    this.retryWait = RETRY_FIRST_MS;
    this.retryAt = 0; // no asking again before this
  }

  start() {
    this.refresh();
    setInterval(() => this.refresh(), REFRESH_MS);
    this.settings.on('change', (_, changed) => {
      if (changed.includes('units') || changed.includes('location')) this.refresh();
    });
  }

  refresh() {
    this.inflight ??= this.#refresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  /**
   * Tries again now if the weather is unavailable and the last try's wait is over. Returns
   * 'started', 'busy', 'notNeeded', or the seconds left to wait.
   */
  async retry() {
    if (this.state.status !== 'error') return 'notNeeded';
    if (this.inflight) return 'busy';
    const left = this.retryAt - Date.now();
    if (left > 0) return Math.ceil(left / 1000);
    this.#set({ status: 'loading' });
    await this.refresh();
    if (this.state.status === 'loading') this.#set({ status: 'error', message: 'Weather unavailable' });
    if (this.state.status === 'error') {
      this.retryAt = Date.now() + this.retryWait;
      this.retryWait = Math.min(this.retryWait * 2, RETRY_MAX_MS);
    }
    return 'started';
  }

  async #refresh() {
    const place = await this.#location();
    if (!place) return;
    const units = this.settings.get().units;
    try {
      const data = await fetchForecast(place, units);
      this.#set(toState(data, place, units));
      this.retryWait = RETRY_FIRST_MS;
      this.retryAt = 0;
    } catch (err) {
      log.warn('[weather]', err.message);
      if (this.state.status !== 'ok') this.#set({ status: 'error', message: 'Weather unavailable' });
    }
  }

  async #location() {
    const loc = this.settings.get().location;
    if (loc.mode === 'manual') return { name: loc.name, lat: loc.lat, lon: loc.lon, source: 'manual' };
    if (this.auto && Date.now() - this.auto.at < RELOCATE_MS) return this.auto;

    const r = await this.helper.location().catch((err) => ({ ok: false, status: 'unavailable', error: err.message }));
    if (r.ok) {
      this.auto = { name: this.#name(r), lat: r.lat, lon: r.lon, source: 'auto', at: Date.now() };
      return this.auto;
    }
    if (this.auto) return this.auto; // transient failure: keep using the last fix
    log.warn(`[weather] no location (${r.status}${r.error ? `: ${r.error}` : ''})`);
    this.#set({ status: 'noLocation', reason: r.status });
    return null;
  }

  /// The place name for a located fix. A reply can carry good coordinates and no name: the
  /// helper answers on a 20s deadline, and if the reverse geocode is still out when it expires
  /// it sends the fix CoreLocation already holds, unnamed but `ok`. Taken at face value that
  /// turns a resolved town into "Current location" until some later geocode happens to land —
  /// which is the whole of the bug, since the forecast itself was right all along. So a name
  /// already resolved for this spot stands. Moving invalidates it: the coordinates are sound
  /// even in the unnamed reply, so a fix that is no longer near the named one falls back rather
  /// than labelling the new place with the old town's name.
  ///
  /// "Near" is measured from where the geocode actually resolved the name, not from the last fix
  /// to inherit it. Those differ once an unnamed fix is accepted, because it keeps the name while
  /// carrying its own coordinates: anchoring to it would let each hop re-centre the circle on the
  /// edge of the last one, so the name could walk any distance in 5 km steps while every single
  /// step passed the check. Holding the anchor still bounds the error at 5 km from the one place
  /// the name was ever known to be right.
  ///
  /// The helper no longer hits that path in normal use — it answers in about 0.1s, named — but
  /// this stays as the backstop for a cold start with no fix to hand. If it starts showing up
  /// again, the reply carries `nameError` saying which half fell short.
  #name(r) {
    if (r.name) {
      this.named = { name: r.name, lat: r.lat, lon: r.lon };
      return r.name;
    }
    const near = this.named
      && Math.abs(this.named.lat - r.lat) < NEARBY_DEG
      && Math.abs(this.named.lon - r.lon) < NEARBY_DEG;
    return near ? this.named.name : 'Current location';
  }

  #set(state) {
    this.state = state;
    this.emit('change', state);
  }
}

async function fetchForecast({ lat, lon }, units) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lon.toFixed(2),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
    temperature_unit: units === 'C' ? 'celsius' : 'fahrenheit',
    wind_speed_unit: units === 'C' ? 'kmh' : 'mph',
    timezone: 'auto',
    timeformat: 'unixtime',
    forecast_days: '7',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return res.json();
}

function toState(d, place, units) {
  const r = Math.round;
  const now = Date.now() / 1000;
  const h = d.hourly;
  const start = Math.max(0, h.time.findLastIndex((t) => t <= now));
  // Eleven hours from the current one: the forecast shows the first five, Today every other one.
  const hourly = h.time.slice(start, start + 11).map((t, i) => ({
    t: t * 1000,
    temp: r(h.temperature_2m[start + i]),
    code: h.weather_code[start + i],
    isDay: h.is_day[start + i] === 1,
    pop: h.precipitation_probability[start + i] ?? 0,
  }));
  const dd = d.daily;
  const daily = dd.time.slice(0, 6).map((t, i) => ({
    t: t * 1000,
    code: dd.weather_code[i],
    hi: r(dd.temperature_2m_max[i]),
    lo: r(dd.temperature_2m_min[i]),
    pop: dd.precipitation_probability_max[i] ?? 0,
  }));
  const c = d.current;
  return {
    status: 'ok',
    place: place.name,
    source: place.source,
    units,
    utcOffset: d.utc_offset_seconds, // the place's timezone, for labelling hours/days
    current: {
      temp: r(c.temperature_2m),
      feels: r(c.apparent_temperature),
      code: c.weather_code,
      isDay: c.is_day === 1,
      humidity: c.relative_humidity_2m,
      wind: r(c.wind_speed_10m),
    },
    today: { hi: daily[0].hi, lo: daily[0].lo, sunrise: dd.sunrise[0] * 1000, sunset: dd.sunset[0] * 1000 },
    hourly,
    daily,
    updatedAt: Date.now(),
  };
}

/** Place search for the Mac settings page. */
export async function searchPlaces(query) {
  const params = new URLSearchParams({ name: query, count: '8', language: 'en' });
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`geocoding HTTP ${res.status}`);
  const { results = [] } = await res.json();
  return results.map((p) => ({
    name: p.name,
    region: p.admin1 || '',
    country: p.country || p.country_code || '',
    lat: p.latitude,
    lon: p.longitude,
  }));
}
