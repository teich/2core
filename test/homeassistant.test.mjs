import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeAssistantWeather, rainMeasurement, forecastRain } from '../server/homeassistant.mjs';

const now = Date.parse('2026-09-27T12:00:00Z');
const reading = (state, unit, age = 60000) => ({ state, attributes: { unit_of_measurement: unit }, last_reported: new Date(now - age).toISOString() });
const hours = (amount, probability, count = 12) => Array.from({ length: count }, (_, i) => ({ datetime: new Date(now + i * 3600000 + 60000).toISOString(), precipitation: amount, precipitation_probability: probability }));

test('rain readings convert units and treat stale or unknown values as missing', () => {
  assert.equal(rainMeasurement(reading('0.1', 'in/h'), true, now), 2.54);
  assert.equal(rainMeasurement(reading('3', 'mm'), false, now), 3);
  assert.equal(rainMeasurement(reading('3', 'mm/h'), false, now), null);
  assert.equal(rainMeasurement(reading('3', 'mm', 31 * 60000), false, now), null);
  assert.equal(rainMeasurement(reading('unavailable', 'mm'), false, now), null);
  assert.equal(rainMeasurement(reading('-1', 'mm'), false, now), null);
});

test('forecasts need twelve complete hours and use the lowest wet-hour probability', () => {
  assert.deepEqual(forecastRain(hours(0.5, 80), 'mm', now), { forecastMm: 6, forecastProbability: 80 });
  assert.equal(forecastRain(hours(0.5, 80, 11), 'mm', now), null);
  assert.equal(forecastRain(hours(0.5, 80), 'cm', now), null);
  const rows = hours(0, 10); rows[3] = { ...rows[3], precipitation: 0.1, precipitation_probability: 40 };
  assert.deepEqual(forecastRain(rows, 'in', now), { forecastMm: 0.1 * 25.4, forecastProbability: 40 });
});

test('the reader combines entities over the REST API with the bearer token', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push([url.pathname + url.search, init.method, init.headers.Authorization]);
    const body = {
      '/api/states/sensor.rain_rate': reading('1.2', 'mm/h'),
      '/api/states/sensor.rain_today': reading('4', 'mm', 120000),
      '/api/states/weather.home': { state: 'rainy', attributes: { precipitation_unit: 'mm' } },
      '/api/services/weather/get_forecasts?return_response': { service_response: { 'weather.home': { forecast: hours(1, 90) } } },
    }[url.pathname + url.search];
    return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404 };
  };
  const weather = new HomeAssistantWeather({ url: 'http://ha.local:8123', token: 'ha-token', intensityEntity: 'sensor.rain_rate', accumulationEntity: 'sensor.rain_today', forecastEntity: 'weather.home', fetch, clock: () => now });
  const sample = await weather.sample();
  assert.deepEqual(sample, { intensityMmH: 1.2, accumulationMm: 4, forecastMm: 12, forecastProbability: 90, observedAt: new Date(now - 120000).toISOString() });
  assert.ok(calls.every(([, , auth]) => auth === 'Bearer ha-token'));
  assert.equal(calls.at(-1)[1], 'POST');
});

test('a missing entity yields no sample and a rejected token is reported', async () => {
  const missing = new HomeAssistantWeather({ url: 'http://ha.local:8123', token: 't', intensityEntity: 'sensor.none', fetch: async () => ({ ok: false, status: 404 }), clock: () => now });
  assert.equal(await missing.sample(), null);
  const rejected = new HomeAssistantWeather({ url: 'http://ha.local:8123', token: 't', intensityEntity: 'sensor.rain', fetch: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(rejected.sample(), /rejected the access token/);
});
