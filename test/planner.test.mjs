import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dateKey, durationText, gaps, parseDuration, resolvePlan, sunrise } from '../lib/planner.mjs';

const start = new Date(2026, 8, 30);
const zones = [{ id: '1' }, { id: '2' }, { id: '3' }];
const cells = (plan, id) => plan.zones.find(z => z.id === id).cells.map(c => c.kind === 'water' ? 'W' : c.kind === 'held' ? 'R' : c.kind === 'deferred' ? '!' : '.').join('');
const sunriseAt = () => 7 * 60;

test('durations accept minutes, min:sec, seconds and hours', () => {
  assert.equal(parseDuration('25'), 1500);
  assert.equal(parseDuration('7.5'), 450);
  assert.equal(parseDuration('0:20'), 20);
  assert.equal(parseDuration('20s'), 20);
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('1h30'), 5400);
  assert.equal(parseDuration(''), null);
  assert.ok(Number.isNaN(parseDuration('soon')));
  for (const s of [20, 450, 1500, 5400, 7200, 9000]) assert.equal(parseDuration(durationText(s)), s);
});

test('several times a week spreads the days; twice a week alternates 3 and 4', () => {
  assert.deepEqual(gaps({ perWeek: 2 }), [3, 4]);
  assert.deepEqual(gaps({ perWeek: 3 }), [2, 2, 3]);
  assert.deepEqual(gaps({ every: 5 }), [5]);
  const plan = resolvePlan({ zones, start, sunriseAt, intents: { 1: { seconds: 600, cadence: { perWeek: 2 }, enabled: true, firstDue: null } } });
  assert.equal(cells(plan, '1'), 'W..W...W..W...');
});

test('rain holds due zones to the first clear night and restarts the rhythm from there', () => {
  const plan = resolvePlan({ zones, start, sunriseAt, rain: new Set([dateKey(addDays(start, 2)), dateKey(addDays(start, 3))]),
    intents: { 1: { seconds: 600, cadence: { every: 2 }, enabled: true, firstDue: null } } });
  assert.equal(cells(plan, '1'), 'W.RRW.W.W.W.W.');
  assert.deepEqual(plan.nights[4].late, [{ zone: '1', nights: 2, reason: 'rain' }]);
});

test('a past first due date rolls forward as if each watering happened', () => {
  const plan = resolvePlan({ zones, start, sunriseAt, intents: { 1: { seconds: 600, cadence: { every: 3 }, enabled: true, firstDue: '2026-09-25' } } });
  assert.equal(cells(plan, '1'), '.W..W..W..W..W');
});

test('nights end at the preferred finish, use two lanes longest first, and never start early', () => {
  const intents = { 1: { seconds: 3600, cadence: { every: 1 } }, 2: { seconds: 1800, cadence: { every: 1 } }, 3: { seconds: 1200, cadence: { every: 1 } } };
  const night = resolvePlan({ zones, start, sunriseAt, intents }).nights[0];
  assert.equal(night.preferredFinish, 1440 + 7 * 60 - 15);
  assert.equal(night.finish, night.preferredFinish);
  assert.deepEqual(night.lanes.map(l => l.map(r => r.zone)), [['1'], ['2', '3']]);
  const one = resolvePlan({ zones, start, sunriseAt, intents, settings: { lanes: 1, earliestStart: 1440 + 6 * 60 } }).nights[0];
  assert.equal(one.start, 1440 + 6 * 60);
  assert.equal(one.status, 'late');
});

test('work that cannot fit before the hard deadline is deferred, not shortened', () => {
  const intents = { 1: { seconds: 4 * 3600, cadence: { every: 1 } }, 2: { seconds: 4 * 3600, cadence: { every: 1 } }, 3: { seconds: 3600, cadence: { every: 1 } } };
  const plan = resolvePlan({ zones, start, sunriseAt, intents, settings: { lanes: 1, earliestStart: 1440, hardDeadline: 8 * 60 } });
  assert.deepEqual(plan.nights[0].deferred, ['3']);
  assert.equal(plan.nights[0].needMinutes, 60);
  assert.equal(plan.nights[0].status, 'over');
  // The deferred zone goes first the next night.
  assert.equal(plan.nights[1].lanes[0][0].zone, '3');
});

test('zones without a run length or cadence, or paused, do not water', () => {
  const plan = resolvePlan({ zones, start, sunriseAt, intents: { 1: { seconds: 600 }, 2: { cadence: { every: 1 } }, 3: { seconds: 600, cadence: { every: 1 }, enabled: false } } });
  assert.deepEqual(plan.zones.map(z => z.problem), ['cadence', 'duration', 'paused']);
  assert.ok(plan.nights.every(n => n.start == null));
});

test('sunrise follows the almanac', () => {
  // Greenwich at the March equinox rises close to 6:04 UTC; compare in UTC.
  const local = sunrise(new Date(2026, 2, 20), 51.48, 0);
  const offset = -new Date(2026, 2, 20, 6).getTimezoneOffset();
  assert.ok(Math.abs(((local - offset) % 1440 + 1440) % 1440 - (6 * 60 + 4)) < 5);
});
