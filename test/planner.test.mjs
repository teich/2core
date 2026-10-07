import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  dateKey,
  durationText,
  gaps,
  parseDuration,
  resolvePlan,
  proposeRebalance,
  staggerIntents,
  sunrise,
} from '../lib/planner.mjs';

const start = new Date(2026, 8, 30);
const zones = [{ id: '1' }, { id: '2' }, { id: '3' }];
const cells = (plan, id) =>
  plan.zones
    .find(z => z.id === id)
    .cells.map(c => (c.kind === 'water' ? 'W' : c.kind === 'held' ? 'R' : c.kind === 'deferred' ? '!' : '.'))
    .join('');
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
  const plan = resolvePlan({
    zones,
    start,
    sunriseAt,
    intents: { 1: { seconds: 600, cadence: { perWeek: 2 }, enabled: true, firstDue: null } },
  });
  assert.equal(cells(plan, '1'), 'W..W...W..W...');
});

test('a past first due date rolls forward as if each watering happened', () => {
  const plan = resolvePlan({
    zones,
    start,
    sunriseAt,
    intents: { 1: { seconds: 600, cadence: { every: 3 }, enabled: true, firstDue: '2026-09-25' } },
  });
  assert.equal(cells(plan, '1'), '.W..W..W..W..W');
});

test('nights prefer one lane, end at the preferred finish, and never start early', () => {
  const intents = {
    1: { seconds: 3600, cadence: { every: 1 } },
    2: { seconds: 1800, cadence: { every: 1 } },
    3: { seconds: 1200, cadence: { every: 1 } },
  };
  const night = resolvePlan({ zones, start, sunriseAt, intents }).nights[0];
  assert.equal(night.preferredFinish, 1440 + 7 * 60 - 15);
  assert.equal(night.finish, night.preferredFinish);
  assert.deepEqual(
    night.lanes.map(l => l.map(r => r.zone)),
    [['1', '2', '3'], []],
  );
  const one = resolvePlan({ zones, start, sunriseAt, intents, settings: { lanes: 1, earliestStart: 1440 + 6 * 60 } })
    .nights[0];
  assert.equal(one.start, 1440 + 6 * 60);
  assert.equal(one.status, 'late');
});

test('work that cannot fit before the hard deadline is deferred, not shortened', () => {
  const intents = {
    1: { seconds: 4 * 3600, cadence: { every: 1 } },
    2: { seconds: 4 * 3600, cadence: { every: 1 } },
    3: { seconds: 3600, cadence: { every: 1 } },
  };
  const plan = resolvePlan({
    zones,
    start,
    sunriseAt,
    intents,
    settings: { lanes: 1, earliestStart: 1440, hardDeadline: 8 * 60 },
  });
  assert.deepEqual(plan.nights[0].deferred, ['3']);
  assert.equal(plan.nights[0].needMinutes, 60);
  assert.equal(plan.nights[0].status, 'over');
  // The deferred zone goes first the next night.
  assert.equal(plan.nights[1].lanes[0][0].zone, '3');
});

test('zones without a run length or cadence, or paused, do not water', () => {
  const plan = resolvePlan({
    zones,
    start,
    sunriseAt,
    intents: {
      1: { seconds: 600 },
      2: { cadence: { every: 1 } },
      3: { seconds: 600, cadence: { every: 1 }, enabled: false },
    },
  });
  assert.deepEqual(
    plan.zones.map(z => z.problem),
    ['cadence', 'duration', 'paused'],
  );
  assert.ok(plan.nights.every(n => n.start == null));
});

test('sunrise follows the almanac', () => {
  // Greenwich at the March equinox rises close to 6:04 UTC; compare in UTC.
  const local = sunrise(new Date(2026, 2, 20), 51.48, 0);
  const offset = -new Date(2026, 2, 20, 6).getTimezoneOffset();
  assert.ok(Math.abs(((((local - offset) % 1440) + 1440) % 1440) - (6 * 60 + 4)) < 5);
});

test('covered zones water through rain while exposed zones catch up and shift cadence', () => {
  const plan = resolvePlan({
    zones,
    start,
    sunriseAt,
    nights: 6,
    rain: new Set([dateKey(start), dateKey(addDays(start, 1))]),
    intents: {
      1: { seconds: 600, cadence: { every: 2 }, waterDuringRain: true },
      2: { seconds: 1200, cadence: { every: 2 } },
      3: { seconds: 600, cadence: { every: 1 }, waterDuringRain: true, enabled: false },
    },
  });
  assert.equal(cells(plan, '1'), 'W.W.W.');
  assert.equal(cells(plan, '2'), 'RRW.W.');
  assert.equal(cells(plan, '3'), '......');
  assert.equal(plan.nights[0].status, 'ok');
  assert.deepEqual(plan.nights[0].held, ['2']);
  assert.equal(plan.nights[0].seconds, 600);
  assert.deepEqual(plan.nights[2].late, [{ zone: '2', nights: 2, reason: 'rain' }]);
});

test('rain exemption does not bypass capacity or shorten runs', () => {
  const plan = resolvePlan({
    zones,
    start,
    sunriseAt,
    rain: new Set([dateKey(start)]),
    settings: { lanes: 1, earliestStart: 1560, hardDeadline: 240 },
    intents: { 1: { seconds: 14400, cadence: { every: 1 }, waterDuringRain: true } },
  });
  assert.equal(plan.nights[0].status, 'over');
  assert.deepEqual(plan.nights[0].deferred, ['1']);
  assert.equal(plan.nights[0].seconds, 0);
});

test('staggering fills around established dates and never changes anchored intentions', () => {
  const original = {
    1: { seconds: 3600, cadence: { every: 2 }, firstDue: dateKey(start) },
    2: { seconds: 3600, cadence: { every: 2 } },
  };
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
  const saved = structuredClone(intents),
    p = proposeRebalance(intents, start);
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
  const intents = {
    1: { seconds: 3600, cadence: { every: 2 }, firstDue: dateKey(addDays(start, 1)) },
    2: { seconds: 3600, cadence: { every: 2 }, firstDue: dateKey(addDays(start, 1)) },
  };
  const p = proposeRebalance(intents, start);
  assert.equal(p.changes[0].days, -1);
  assert.equal(p.changes[0].after, dateKey(start));
});

test('seasonal run lengths determine staggering and rebalance loads without changing baselines', () => {
  const intents = {
    1: { seconds: 7200, cadence: { every: 2 }, seasonalPercent: 50 },
    2: { seconds: 3600, cadence: { every: 2 }, seasonalPercent: 200 },
  };
  const anchored = staggerIntents(intents, start);
  const plan = resolvePlan({ zones, start, sunriseAt, intents: anchored });
  // Zone 2 is now the heavier run, despite its smaller baseline.
  assert.equal(cells(plan, '2'), 'W.W.W.W.W.W.W.');
  assert.equal(cells(plan, '1'), '.W.W.W.W.W.W.W');
  assert.equal(plan.nights[0].seconds, 7200);
  assert.equal(plan.nights[1].seconds, 3600);
  const together = Object.fromEntries(
    Object.entries(intents).map(([id, intent]) => [id, { ...intent, firstDue: dateKey(start) }]),
  );
  const proposal = proposeRebalance(together, start);
  assert.equal(proposal.beforePeakSeconds, 10800);
  assert.equal(proposal.afterPeakSeconds, 7200);
  assert.equal(anchored['1'].seconds, 7200);
  assert.equal(anchored['2'].seconds, 3600);
  const fractional = resolvePlan({
    zones,
    start,
    intents: { 1: { seconds: 61, cadence: { every: 1 }, seasonalPercent: 150 } },
  });
  assert.equal(fractional.nights[0].seconds, 92);
});

function nightFor(minutes, settings = {}, extra = {}) {
  return resolvePlan({
    zones: minutes.map((_, i) => ({ id: String(i) })),
    start,
    nights: 1,
    sunriseAt: () => 6 * 60 + 15,
    intents: Object.fromEntries(minutes.map((m, i) => [i, { seconds: Math.round(m * 60), cadence: { every: 1 } }])),
    settings: { earliestStart: 1440, hardDeadline: 8 * 60, ...settings },
    ...extra,
  }).nights[0];
}
const overlapMinutes = n =>
  n.lanes.length < 2
    ? 0
    : n.lanes[0].reduce(
        (sum, a) =>
          sum + n.lanes[1].reduce((s, b) => s + Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from)), 0),
        0,
      );

test('second lane overlaps only for the time missing from the preferred nighttime window', () => {
  const n = nightFor([240, 120, 30]);
  assert.equal(n.start, 1440);
  assert.equal(n.finish, 1800);
  assert.equal(overlapMinutes(n), 30);
  assert.deepEqual(
    n.lanes.map(l => l.map(r => r.zone)),
    [['0', '1'], ['2']],
  );
  assert.equal(n.lanes[1][0].from, 1770);
  assert.deepEqual(n.deferred, []);
  assert.equal(nightFor([240, 120]).lanes[1].length, 0);
  assert.equal(nightFor([240, 120, 30], { lanes: 1 }).lanes.length, 1);
});

test('packing finds a feasible night that longest-first balancing would miss', () => {
  const n = nightFor([180, 180, 120, 120, 120], { hardDeadline: 360 });
  assert.deepEqual(n.deferred, []);
  assert.equal(n.finish, 1800);
  assert.deepEqual(
    n.lanes.map(l => l.reduce((s, r) => s + r.seconds / 60, 0)),
    [360, 360],
  );
});

test('extends beyond preferred finish only when necessary and never beyond hard deadline', () => {
  const n = nightFor([240, 240, 240]);
  assert.equal(n.finish, 1920);
  assert.equal(overlapMinutes(n), 240);
  const capped = nightFor([240, 240, 240], { hardDeadline: 360 });
  assert.deepEqual(capped.deferred, ['2']);
  assert.ok(capped.finish <= capped.hardDeadline);
  const earlyDeadline = nightFor([60], { hardDeadline: 240 });
  assert.equal(earlyDeadline.finish, earlyDeadline.hardDeadline);
});

test('whole-second runs, seasonal adjustment and rain holds affect the need for overlap', () => {
  assert.ok(Math.abs(overlapMinutes(nightFor([240, 120, 1 / 60])) - 1 / 60) < 1e-9);
  const intents = {
    0: { seconds: 14400, cadence: { every: 1 }, seasonalPercent: 150 },
    1: { seconds: 3600, cadence: { every: 1 }, waterDuringRain: true },
  };
  assert.equal(overlapMinutes(nightFor([0, 0], {}, { intents })), 60);
  const rain = nightFor([0, 0], {}, { intents, rain: new Set([dateKey(start)]) });
  assert.equal(rain.lanes[1].length, 0);
  assert.deepEqual(rain.held, ['0']);
});

test('small schedules match exhaustive two-lane feasibility and minimum overlap', () => {
  // Deterministic varied durations, including cases requiring a later finish.
  let seed = 12345;
  for (let trial = 0; trial < 100; trial++) {
    const minutes = Array.from({ length: 6 }, () => {
      seed = (seed * 16807) % 2147483647;
      return 20 + (seed % 150);
    });
    const total = minutes.reduce((a, b) => a + b, 0);
    let minimumLength = Infinity;
    for (let mask = 0; mask < 1 << minutes.length; mask++) {
      const sum = minutes.reduce((s, m, i) => s + ((mask >> i) & 1 ? m : 0), 0);
      minimumLength = Math.min(minimumLength, Math.max(sum, total - sum));
    }
    const n = nightFor(minutes);
    assert.deepEqual(n.deferred, []);
    assert.equal(n.finish, 1440 + Math.max(360, minimumLength));
    assert.equal(overlapMinutes(n), Math.max(0, total - Math.max(360, minimumLength)));
    const runs = n.lanes.flat();
    assert.equal(new Set(runs.map(r => r.zone)).size, minutes.length);
    for (const r of runs) {
      assert.equal(r.seconds, minutes[Number(r.zone)] * 60);
      assert.ok(r.from >= n.earliestStart && r.to <= n.hardDeadline);
    }
  }
});
