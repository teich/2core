import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WeatherFlow, forecastRain } from '../server/weatherflow.mjs';

const now = Date.parse('2026-10-20T12:00:00Z'), seconds = ms => Math.round(ms / 1000);
const hours = (precip, probability, count = 12) => Array.from({ length: count }, (_, i) => ({ time: seconds(now + i * 3600000 + 600000), precip, precip_probability: probability }));
const api = (routes, calls = []) => async url => {
  calls.push(url);
  const route = url.pathname.replace('/swd/rest/', '');
  const body = typeof routes[route] === 'function' ? routes[route](url) : routes[route];
  return body === undefined ? { ok: false, status: 404 } : body.httpStatus ? { ok: false, status: body.httpStatus } : { ok: true, status: 200, json: async () => body };
};
const observation = (precip = 0.05, age = 60000) => ({ status: { status_code: 0 }, station_name: 'Garage', station_units: { units_precip: 'in' }, obs: [{ timestamp: seconds(now - age), precip, precip_accum_last_1hr: 0.8 }] });
const forecast = (day = 4.2, hourly = hours(1, 90)) => ({ status: { status_code: 0 }, current_conditions: { time: seconds(now - 120000), precip_accum_local_day: day }, forecast: { hourly } });

test('forecasts need twelve complete hours and use the lowest wet-hour probability', () => {
  assert.deepEqual(forecastRain(hours(0.5, 80), now), { forecastMm: 6, forecastProbability: 80 });
  assert.equal(forecastRain(hours(0.5, 80, 11), now), null);
  const rows = hours(0, 10); rows[3] = { ...rows[3], precip: 2, precip_probability: 40 };
  assert.deepEqual(forecastRain(rows, now), { forecastMm: 2, forecastProbability: 40 });
});

test('a sample combines the observation and forecast, in millimeters with the owner’s display unit', async () => {
  const calls = [];
  const weather = new WeatherFlow({ token: 'wf-token', stationId: 67, clock: () => now,
    fetch: api({ 'observations/station/67': observation(), better_forecast: forecast() }, calls) });
  assert.deepEqual(await weather.sample(), { unit: 'in', intensityMmH: 3, accumulationMm: 4.2, forecastMm: 12, forecastProbability: 90, observedAt: new Date(now - 120000).toISOString() });
  assert.ok(calls.every(url => url.searchParams.get('token') === 'wf-token'));
  assert.equal(calls.find(url => url.pathname.endsWith('better_forecast')).searchParams.get('units_precip'), 'mm');
  assert.deepEqual(weather.describe().station, { id: '67', name: 'Garage' });
});

test('stale readings are dropped, and a forecast failure keeps the observation', async () => {
  const stale = new WeatherFlow({ token: 't', stationId: 1, clock: () => now,
    fetch: api({ 'observations/station/1': observation(0.05, 31 * 60000), better_forecast: { ...forecast(4, []), current_conditions: { time: seconds(now - 31 * 60000), precip_accum_local_day: 4 } } }) });
  assert.equal(await stale.sample(), null);
  const partial = new WeatherFlow({ token: 't', stationId: 1, clock: () => now,
    fetch: api({ 'observations/station/1': observation(0), better_forecast: { httpStatus: 500 } }) });
  assert.deepEqual(await partial.sample(), { unit: 'in', intensityMmH: 0, observedAt: new Date(now - 60000).toISOString() });
});

test('a single station is found automatically; several need a configured ID; a bad token is reported', async () => {
  const single = new WeatherFlow({ token: 't', clock: () => now,
    fetch: api({ stations: { status: { status_code: 0 }, stations: [{ station_id: 42 }] }, 'observations/station/42': observation(), better_forecast: forecast() }) });
  assert.equal((await single.sample()).intensityMmH, 3);
  const several = new WeatherFlow({ token: 't', fetch: api({ stations: { status: { status_code: 0 }, stations: [{ station_id: 1 }, { station_id: 2 }] } }) });
  await assert.rejects(several.sample(), /set WEATHERFLOW_STATION_ID/);
  const rejected = new WeatherFlow({ token: 't', stationId: 1, fetch: api({ 'observations/station/1': { httpStatus: 401 } }) });
  await assert.rejects(rejected.sample(), /rejected the access token/);
});
