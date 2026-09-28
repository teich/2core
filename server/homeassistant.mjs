// Reads Tempest rain entities and an optional hourly forecast from Home Assistant's REST API.
// Home Assistant is only a weather source; it never sees Tucor credentials or controls zones.
const finite = x => Number.isFinite(x) && x >= 0;

// Millimeters (per hour for intensity), or null for stale, unknown, or unconvertible readings.
export function rainMeasurement(state, intensity = false, now = Date.now()) {
  if (!state || ['unknown', 'unavailable', ''].includes(state.state)) return null;
  const reported = Date.parse(state.last_reported ?? state.last_updated);
  const age = now - reported;
  if (!Number.isFinite(age) || age < -60000 || age > 30 * 60000) return null;
  const value = Number(state.state);
  if (state.state === null || !finite(value)) return null;
  const factor = (intensity ? { 'mm/h': 1, 'in/h': 25.4 } : { mm: 1, in: 25.4 })[state.attributes?.unit_of_measurement ?? ''];
  return factor === undefined ? null : value * factor;
}

// Requires twelve complete hourly buckets with an amount and a probability.
export function forecastRain(rows, unit, now = Date.now()) {
  if (!['mm', 'in'].includes(unit) || !Array.isArray(rows)) return null;
  const buckets = new Map();
  for (const row of rows) {
    const delta = Date.parse(row?.datetime) - now;
    const amount = Number(row?.precipitation), probability = Number(row?.precipitation_probability);
    if (row?.precipitation == null || row?.precipitation_probability == null) continue;
    if (delta >= 0 && delta < 12 * 3600000 && finite(amount) && finite(probability) && probability <= 100) buckets.set(Math.floor(delta / 3600000), [amount, probability]);
  }
  if (buckets.size !== 12) return null;
  const values = [...buckets.values()];
  // Conservatively use the lowest probability among the hours that predict rain.
  const wet = values.filter(([amount]) => amount > 0).map(([, p]) => p);
  return { forecastMm: values.reduce((sum, [amount]) => sum + amount, 0) * (unit === 'in' ? 25.4 : 1), forecastProbability: wet.length ? Math.min(...wet) : 0 };
}

export class HomeAssistantWeather {
  constructor({ url, token, intensityEntity, accumulationEntity, forecastEntity, fetch = globalThis.fetch, clock = Date.now }) {
    if (!url || !token) throw new Error('Home Assistant weather needs HA_URL and HA_TOKEN');
    if (!intensityEntity && !accumulationEntity && !forecastEntity) throw new Error('Configure at least one Home Assistant weather entity');
    Object.assign(this, { url: new URL(url), token, intensityEntity, accumulationEntity, forecastEntity, fetch, clock });
  }
  describe() {
    return { configured: true, source: 'Home Assistant', entities: [this.intensityEntity, this.accumulationEntity, this.forecastEntity].filter(Boolean) };
  }
  async call(path, body) {
    const http = this.fetch;
    const response = await http(new URL(path, this.url), {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401) throw new Error('Home Assistant rejected the access token');
    if (!response.ok) throw new Error(`Home Assistant HTTP ${response.status}`);
    return response.json();
  }
  async entity(id) {
    try { return await this.call(`/api/states/${encodeURIComponent(id)}`); }
    catch (e) { if (/HTTP 404/.test(e.message)) return null; throw e; }
  }
  // Returns a sample for Engine.weather, or null when nothing usable was reported.
  async sample() {
    const now = this.clock(), sample = {}, times = [];
    for (const [id, key, intensity] of [[this.intensityEntity, 'intensityMmH', true], [this.accumulationEntity, 'accumulationMm', false]]) {
      if (!id) continue;
      const state = await this.entity(id);
      const value = rainMeasurement(state, intensity, now);
      if (value !== null) { sample[key] = value; times.push(Date.parse(state.last_reported ?? state.last_updated)); }
    }
    if (this.forecastEntity) {
      try {
        const weather = await this.entity(this.forecastEntity);
        if (weather && !['unknown', 'unavailable'].includes(weather.state)) {
          const response = await this.call('/api/services/weather/get_forecasts?return_response', { entity_id: this.forecastEntity, type: 'hourly' });
          const forecast = forecastRain(response?.service_response?.[this.forecastEntity]?.forecast, weather.attributes?.precipitation_unit, now);
          if (forecast) { Object.assign(sample, forecast); times.push(now); }
        }
      } catch { /* A forecast failure must not discard valid local rain observations. */ }
    }
    if (!times.length) return null;
    return { ...sample, observedAt: new Date(Math.min(...times)).toISOString() };
  }
}
