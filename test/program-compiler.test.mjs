import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compilePrograms } from '../lib/program-compiler.mjs';
import { addDays, dateKey, resolvePlan } from '../lib/planner.mjs';

const start = new Date(2026, 9, 6);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/program-intents.json', import.meta.url)));
const compile = (extra = {}) => compilePrograms({ zones: fixture.zones, ...fixture.plan, start, sunriseAt: () => 431, ...extra });
function small(minutes, extra = {}) {
  return compilePrograms({ zones: minutes.map((_, i) => ({ id: String(i) })),
    intents: Object.fromEntries(minutes.map((m, i) => [i, { seconds: m * 60, cadence: { every: 1 } }])),
    start, settings: { earliestStart: 1440, finishBeforeSunrise: 0, hardDeadline: 480 }, sunriseAt: () => 360, ...extra });
}

// Expand calendar *start dates*, not the compiler's evening masks, to check that
// post-midnight programs keep their intended dates across the repeating seam.
function verify(p, input) {
  assert.equal(p.status, 'candidate', JSON.stringify(p.issues));
  const intents = structuredClone(input.intents);
  for (const [id, enabled] of Object.entries(p.enabledOverrides)) intents[id].enabled = enabled;
  const expected = resolvePlan({ zones: input.zones, intents, settings: input.settings, start, nights: 28, sunriseAt: () => 431 });
  const actual = [];
  for (let calendarDay = 0; calendarDay <= 28; calendarDay++) for (const program of p.programs) {
    if (!program.calendarMask[calendarDay % 14]) continue;
    const eveningDay = calendarDay - program.startDayOffset;
    if (eveningDay < 0 || eveningDay >= 28) continue;
    let at = calendarDay * 86400 + program.clockMinute * 60;
    assert.equal(program.startMinute % 1, 0);
    for (const step of program.steps) {
      actual.push({ zone: step.zone, eveningDay, at, end: at + step.seconds, seconds: step.seconds });
      at += step.seconds;
    }
  }
  for (let d = 0; d < 28; d++) {
    const runs = actual.filter(r => r.eveningDay === d);
    const wanted = expected.nights[d].lanes.flat();
    assert.deepEqual(runs.map(r => `${r.zone}:${r.seconds}`).sort(), wanted.map(r => `${r.zone}:${r.seconds}`).sort(), dateKey(addDays(start, d)));
    const events = runs.flatMap(r => [[r.at, 1], [r.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let count = 0, previous = 0, overlap = 0;
    for (const [at, change] of events) {
      if (count === 2) overlap += at - previous;
      count += change; assert.ok(count <= p.settings.lanes); previous = at;
    }
    assert.equal(overlap, p.nights[d % 14].parallelSeconds);
    for (const r of runs) {
      assert.ok(r.at >= d * 86400 + p.horizon.earliestStart * 60);
      assert.ok(r.end <= d * 86400 + p.horizon.hardDeadline * 60);
    }
  }
}

test('production vineyard-off snapshot compiles into nine serial repeating programs', () => {
  const before = structuredClone(fixture), p = compile();
  assert.equal(p.summary.programs, 9);
  assert.equal(p.summary.zones, 26);
  assert.equal(p.summary.weeklySeconds / 60, 3077.5);
  assert.equal(p.summary.parallelSeconds, 0);
  assert.equal(p.summary.minimumOverlapProven, true);
  assert.equal(p.summary.preferredWindowMet, true);
  verify(p, { zones: fixture.zones, ...fixture.plan });
  assert.deepEqual(fixture, before);
  assert.deepEqual(compile(), p);
});

test('vineyard-on override fits ten programs with provably minimum overlap', () => {
  const p = compile({ enabledOverrides: { 15: true, 16: true } });
  assert.equal(p.summary.programs, 10);
  assert.equal(p.summary.zones, 28);
  assert.equal(p.summary.weeklySeconds / 60, 3917.5);
  assert.equal(p.summary.maxConcurrent, 2);
  assert.equal(p.summary.parallelSeconds, p.summary.parallelLowerBoundSeconds);
  assert.equal(p.summary.minimumOverlapProven, true);
  assert.equal(p.summary.preferredWindowMet, true);
  assert.equal(fixture.plan.intents['15'].enabled, false);
  verify(p, { zones: fixture.zones, ...fixture.plan });
});

test('rain-exempt zones keep separate programs even when their watering dates match', () => {
  const p = small([20, 30], { intents: { 0: { seconds: 1200, cadence: { every: 1 } }, 1: { seconds: 1800, cadence: { every: 1 }, waterDuringRain: true } } });
  assert.equal(p.programs.length, 2);
  assert.deepEqual(p.programs.map(p => p.waterDuringRain), [false, true]);
});

test('nonrepeating cadences, distant anchors and unrepresentable seconds block the whole candidate', () => {
  for (const [intent, code] of [
    [{ seconds: 60, cadence: { every: 3 } }, 'cadence'],
    [{ seconds: 301, cadence: { every: 1 } }, 'runtime-precision'],
    [{ seconds: 60, cadence: { every: 7 }, firstDue: '2026-12-01' }, 'transient-dates'],
    [{ seconds: 60 }, 'incomplete-intent'],
  ]) {
    const p = small([1], { intents: { 0: intent } });
    assert.equal(p.status, 'blocked'); assert.equal(p.issues[0].code, code); assert.deepEqual(p.programs, []);
  }
});

test('short seconds remain exact, and longer supported seconds use whole-minute starts', () => {
  const p = small([20 / 60, 310 / 60], { intents: { 0: { seconds: 20, cadence: { every: 1 } }, 1: { seconds: 310, cadence: { every: 1 }, waterDuringRain: true } } });
  assert.equal(p.status, 'candidate');
  assert.deepEqual(p.programs.map(p => p.seconds), [20, 310]);
  assert.ok(p.programs.every(p => Number.isInteger(p.startMinute)));
  assert.equal(p.summary.parallelSeconds, 0);
});

test('more than ten distinct calendar/rain groups is an explicit compiler limitation', () => {
  const zones = Array.from({ length: 11 }, (_, i) => ({ id: String(i) }));
  const p = small([], { zones, intents: Object.fromEntries(zones.map((z, i) => [z.id, { seconds: 60, cadence: { every: 14 }, firstDue: dateKey(addDays(start, i)) }])) });
  assert.equal(p.status, 'blocked'); assert.equal(p.issues[0].code, 'program-limit');
});

test('a group too long to fit reports no candidate rather than silently dropping work', () => {
  const p = small([300, 300]);
  assert.equal(p.status, 'blocked'); assert.equal(p.issues[0].code, 'no-fit');
  assert.equal(p.summary.weeklySeconds, 600 * 60 * 7);
});

test('a strict single-zone limit is preserved when later finishing is needed', () => {
  const p = small([400], { settings: { lanes: 1, earliestStart: 1440, finishBeforeSunrise: 0, hardDeadline: 480 } });
  assert.equal(p.status, 'candidate'); assert.equal(p.summary.maxConcurrent, 1);
  assert.equal(p.summary.preferredWindowMet, false);
  assert.ok(p.nights.every(n => n.finish <= 1920));
});

test('seasonal scaling is applied once; sunrise uses the earliest morning in the horizon', () => {
  const p = small([60], { intents: { 0: { seconds: 3600, seasonalPercent: 150, cadence: { every: 1 } } }, sunriseAt: d => d.getDate() === 10 ? 300 : 360 });
  assert.equal(p.programs[0].steps[0].seconds, 5400);
  assert.equal(p.programs[0].budgetPercent, 100);
  assert.equal(p.horizon.preferredFinish, 1740);
  assert.ok(p.nights.every(n => n.finish <= 1740));
});

test('empty plans and unknown sunrise are represented explicitly', () => {
  const p = small([], { sunriseAt: () => null });
  assert.equal(p.status, 'candidate'); assert.equal(p.summary.zones, 0);
  assert.equal(p.horizon.sunriseKnown, false); assert.ok(p.nights.every(n => n.start === null));
});

test('walking order does not change compiled program identities or scheduling', () => {
  assert.deepEqual(compile({ zones: [...fixture.zones].reverse() }), compile());
});

test('shorter summer windows still fit the vineyard without exceeding two zones', () => {
  const p = compile({ enabledOverrides: { 15: true, 16: true }, sunriseAt: () => 348 });
  assert.equal(p.status, 'candidate');
  assert.equal(p.summary.preferredWindowMet, true);
  assert.ok(p.nights.every(n => n.peak <= 2 && n.finish <= 1788));
  assert.ok(p.summary.parallelSeconds > compile({ enabledOverrides: { 15: true, 16: true } }).summary.parallelSeconds);
  verify(p, { zones: fixture.zones, ...fixture.plan });
});

test('varied parallel candidates remain bounded and retain all requested watering', () => {
  let seed = 471;
  for (let trial = 0; trial < 30; trial++) {
    const zones = Array.from({ length: 8 }, (_, i) => ({ id: String(i) }));
    const intents = Object.fromEntries(zones.map((z, i) => {
      seed = seed * 16807 % 2147483647;
      return [z.id, { seconds: (60 + seed % 181) * 60, cadence: i < 4 ? { every: 2 } : { perWeek: 3 }, firstDue: dateKey(addDays(start, seed % 2)), waterDuringRain: i % 3 === 0 }];
    }));
    const p = compile({ zones, intents });
    if (p.status === 'candidate') verify(p, { zones, intents, settings: fixture.plan.settings });
    else assert.ok(p.issues.length);
  }
});
