// Reads rain observations and the hourly forecast for a Tempest station from WeatherFlow's REST API.
// Two requests per check: the latest station observation, and the forecast (which also carries today's total).
const API = 'https://swd.weatherflow.com/swd/rest/';
const finite = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const fresh = (seconds, now) => {
  const age = now - seconds * 1000;
  return Number.isFinite(age) && age >= -60000 && age <= 30 * 60000;
};

// Requires twelve complete hourly buckets with an amount and a probability. Amounts are millimeters.
export function forecastRain(hourly, now = Date.now()) {
  if (!Array.isArray(hourly)) return null;
  const buckets = new Map();
  for (const row of hourly) {
    const delta = Number(row?.time) * 1000 - now;
    if (
      delta >= 0 &&
      delta < 12 * 3600000 &&
      finite(row.precip) &&
      finite(row.precip_probability) &&
      row.precip_probability <= 100
    )
      buckets.set(Math.floor(delta / 3600000), [row.precip, row.precip_probability]);
  }
  if (buckets.size !== 12) return null;
  const values = [...buckets.values()];
  // Conservatively use the lowest probability among the hours that predict rain.
  const wet = values.filter(([amount]) => amount > 0).map(([, p]) => p);
  return {
    forecastMm: values.reduce((sum, [amount]) => sum + amount, 0),
    forecastProbability: wet.length ? Math.min(...wet) : 0,
  };
}

export class WeatherFlow {
  constructor({ token, stationId, fetch = globalThis.fetch, clock = Date.now }) {
    if (!token) throw new Error('WeatherFlow weather needs an access token');
    Object.assign(this, { token, stationId: stationId ? String(stationId) : null, fetch, clock });
    this.station = null;
  }
  describe() {
    return {
      configured: true,
      source: 'Tempest',
      station: this.station ?? (this.stationId ? { id: this.stationId } : null),
    };
  }
  async call(path, params = {}) {
    // WeatherFlow takes the token as a query parameter; never log these URLs.
    const url = new URL(path, API);
    for (const [key, value] of Object.entries({ ...params, token: this.token })) url.searchParams.set(key, value);
    const http = this.fetch;
    const response = await http(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (response.status === 401 || response.status === 403) throw new Error('WeatherFlow rejected the access token');
    if (!response.ok) throw new Error(`WeatherFlow HTTP ${response.status}`);
    const body = await response.json();
    if (body?.status && body.status.status_code !== 0)
      throw new Error(`WeatherFlow: ${String(body.status.status_message ?? 'request failed').slice(0, 80)}`);
    return body;
  }
  // Without a configured station, an account with exactly one station uses it.
  async resolveStation() {
    if (this.stationId) return this.stationId;
    const stations = (await this.call('stations')).stations ?? [];
    if (stations.length !== 1)
      throw new Error(
        stations.length
          ? 'This account has several stations; set WEATHERFLOW_STATION_ID'
          : 'No stations on this WeatherFlow account',
      );
    this.stationId = String(stations[0].station_id);
    return this.stationId;
  }
  // Returns a sample for Engine.weather, or null when nothing usable was reported.
  async sample() {
    const now = this.clock(),
      station = await this.resolveStation(),
      sample = {},
      times = [];
    const observation = await this.call(`observations/station/${encodeURIComponent(station)}`);
    this.station = { id: station, name: observation.station_name ?? null };
    if (Number.isFinite(observation.latitude) && Number.isFinite(observation.longitude))
      Object.assign(this.station, { latitude: observation.latitude, longitude: observation.longitude });
    // Observation values are always metric; station_units is only the owner's display preference.
    const unit = observation.station_units?.units_precip;
    if (unit) sample.unit = unit === 'in' ? 'in' : 'mm';
    const latest = observation.obs?.[0];
    if (latest && fresh(latest.timestamp, now) && finite(latest.precip)) {
      sample.intensityMmH = latest.precip * 60; // rain in the last minute, as an hourly rate
      times.push(latest.timestamp * 1000);
    }
    try {
      const forecast = await this.call('better_forecast', { station_id: station, units_precip: 'mm' });
      const current = forecast.current_conditions;
      if (current && fresh(current.time, now) && finite(current.precip_accum_local_day)) {
        sample.accumulationMm = current.precip_accum_local_day;
        times.push(current.time * 1000);
      }
      const hourly = forecastRain(forecast.forecast?.hourly, now);
      if (hourly) {
        Object.assign(sample, hourly);
        times.push(now);
      }
    } catch {
      /* A forecast failure must not discard a valid observation. */
    }
    if (!times.length) return null;
    return { ...sample, observedAt: new Date(Math.min(...times)).toISOString() };
  }
}
