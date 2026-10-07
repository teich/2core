import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dateKey, durationText, gaps, parseDuration, resolvePlan, proposeRebalance, staggerIntents, sunrise } from '../lib/planner.mjs';

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
  assert.deepEqual(gaps({ perWeek: 3 }), [2, 2, 3]);
  const plan = resolvePlan({ zones, start, sunriseAt, intents: { 1: { seconds: 600, cadence: { perWeek: 2 }, enabled: true, firstDue: null } } });
  assert.equal(cells(plan, '1'), 'W..W...W..W...');
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


test('covered zones water through rain while exposed zones catch up and shift cadence', () => {
  const plan = resolvePlan({ zones, start, sunriseAt, nights: 6,
    rain: new Set([dateKey(start), dateKey(addDays(start, 1))]),
    intents: {
      1: { seconds: 600, cadence: { every: 2 }, waterDuringRain: true },
      2: { seconds: 1200, cadence: { every: 2 } },
      3: { seconds: 600, cadence: { every: 1 }, waterDuringRain: true, enabled: false },
    } });
  assert.equal(cells(plan, '1'), 'W.W.W.');
  assert.equal(cells(plan, '2'), 'RRW.W.');
  assert.equal(cells(plan, '3'), '......');
  assert.equal(plan.nights[0].status, 'ok');
  assert.deepEqual(plan.nights[0].held, ['2']);
  assert.equal(plan.nights[0].seconds, 600);
  assert.deepEqual(plan.nights[2].late, [{ zone: '2', nights: 2, reason: 'rain' }]);
});

test('rain exemption does not bypass capacity or shorten runs', () => {
  const plan = resolvePlan({ zones, start, sunriseAt, rain: new Set([dateKey(start)]),
    settings: { lanes: 1, earliestStart: 1560, hardDeadline: 240 },
    intents: { 1: { seconds: 14400, cadence: { every: 1 }, waterDuringRain: true } } });
  assert.equal(plan.nights[0].status, 'over');
  assert.deepEqual(plan.nights[0].deferred, ['1']);
  assert.equal(plan.nights[0].seconds, 0);
});

test('staggering fills around established dates and never changes anchored intentions', () => {
  const original = { 1: { seconds: 3600, cadence: { every: 2 }, firstDue: dateKey(start) },
    2: { seconds: 3600, cadence: { every: 2 } } };
  const anchored = staggerIntents(original, start);
  assert.deepEqual(anchored['1'], original['1']);
  assert.equal(original['2'].firstDue, undefined);
  const p = resolvePlan({ zones, start, intents: anchored, sunriseAt });
  assert.equal(cells(p, '1'), 'W.W.W.W.W.W.W.');
  assert.equal(cells(p, '2'), '.W.W.W.W.W.W.W');
  assert.deepEqual(staggerIntents(anchored, addDays(start, 2)), anchored);
  const tomorrow = resolvePlan({ zones, start: addDays(start, 1), intents: anchored, sunriseAt });
  for (const id of ['1', '2']) assert.equal(cells(tomorrow, id).slice(0, 13), cells(p, id).slice(1));
});

test('explicit rebalance discloses date shifts, improves peak load, and leaves disabled zones alone', () => {
  const intents = {
    1: { seconds: 3600, cadence: { every: 2 }, firstDue: dateKey(start) },
    2: { seconds: 3600, cadence: { every: 2 }, firstDue: dateKey(start) },
    3: { seconds: 14400, cadence: { perWeek: 2 }, firstDue: dateKey(start), enabled: false },
  };
  const saved = structuredClone(intents), p = proposeRebalance(intents, start);
  assert.deepEqual(intents, saved);
  assert.equal(p.beforePeakSeconds, 7200);
  assert.equal(p.afterPeakSeconds, 3600);
  assert.equal(p.changes.length, 1);
  const c = p.changes[0];
  assert.notEqual(c.zone, '3');
  assert.equal(c.days, 1);
  assert.equal(c.before, dateKey(start));
  assert.equal(c.after, dateKey(addDays(start, 1)));
  const changed = { ...intents, [c.zone]: { ...intents[c.zone], firstDue: c.firstDue } };
  assert.equal(cells(resolvePlan({ zones, intents: changed, start }), c.zone), '.W.W.W.W.W.W.W');
  assert.deepEqual(proposeRebalance(changed, start).changes, []);
});

test('rebalance can disclose an earlier run without moving it before tonight', () => {
  const intents = { 1: { seconds: 3600, cadence: { every: 2 }, firstDue: dateKey(addDays(start, 1)) },
    2: { seconds: 3600, cadence: { every: 2 }, firstDue: dateKey(addDays(start, 1)) } };
  const p = proposeRebalance(intents, start);
  assert.equal(p.changes[0].days, -1);
  assert.equal(p.changes[0].after, dateKey(start));
});
