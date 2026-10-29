import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  controllerNight,
  eveningAt,
  eveningFindings,
  nightStatus,
  planNight,
  spotOutcome,
  spotTarget,
} from '../lib/night-checks.mjs';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { DemoDriver } from '../server/demo.mjs';
import { dateKey } from '../lib/planner.mjs';
import { nightClock, nightRows, syncLine } from '../web/model/nights.js';

/** A program as readProgram returns it. */
const program = (id, extra) => ({
  id: String(id),
  name: `Program ${id}`,
  active: true,
  budget: 100,
  type: 'budget',
  period: '14 days',
  days: Array(14).fill(false),
  starts: [{ minute: 1350, cycles: 1, finish: null }],
  steps: [],
  seconds: 0,
  adjustedSeconds: 0,
  firstDay: 3,
  ...extra,
});
const days = (...on) => Array.from({ length: 14 }, (_, d) => on.includes(d));

test('a night’s runs follow the programs’ days, start times, steps and budget', () => {
  const programs = [
    program(1, {
      days: days(0, 2),
      budget: 150,
      steps: [
        { zone: '2', seconds: 1200 },
        { zone: '3', seconds: 600 },
      ],
    }),
    // Starts after midnight belong to the evening before: day 1 at 1:00 is night 0 at 1500.
    program(2, {
      days: days(1),
      starts: [{ minute: 60, cycles: 1, finish: null }],
      steps: [{ zone: '7', seconds: 900 }],
    }),
    program(3, { active: false, days: days(0), steps: [{ zone: '9', seconds: 600 }] }),
    // Odd and even follow the day of the month: the 29th is odd.
    program(4, { period: 'Odd', steps: [{ zone: '11', seconds: 600 }] }),
    program(5, { period: 'Even', steps: [{ zone: '12', seconds: 600 }] }),
  ];
  const night = controllerNight(programs, '2026-10-29', '2026-10-29');
  assert.deepEqual(
    night.map(r => [r.zone, r.from, r.to]),
    [
      ['2', 1350, 1380],
      ['11', 1350, 1360],
      ['3', 1380, 1395],
      ['7', 1500, 1515],
    ],
  );
  // Fourteen days on, the calendar repeats (the 12th is even); the day after has nothing from programs 1 and 2.
  assert.deepEqual(
    controllerNight(programs, '2026-10-29', '2026-11-12').map(r => r.zone),
    ['2', '12', '3', '7'],
  );
  assert.deepEqual(
    controllerNight(programs, '2026-10-29', '2026-10-30').map(r => r.zone),
    ['12'],
  );
  // A program that cycles and soaks has no simple timeline.
  const cycling = controllerNight(
    [
      program(1, {
        days: days(0),
        starts: [{ minute: 1350, cycles: 2, finish: null }],
        steps: [{ zone: '2', seconds: 1800 }],
      }),
    ],
    '2026-10-29',
    '2026-10-29',
  );
  assert.equal(cycling[0].uncertain, true);
  assert.equal(spotTarget(cycling), null);
});

test('the spot check looks at the middle of the longest certain run, and knows what else runs then', () => {
  const runs = [
    { slot: 1, program: 'A', zone: '2', from: 1320, to: 1350 },
    { slot: 2, program: 'B', zone: '5', from: 1330, to: 1400 },
    { slot: 1, program: 'A', zone: '3', from: 1350, to: 1360 },
  ];
  assert.deepEqual(spotTarget(runs), { at: 1365, zone: '5', program: 'B', expected: ['5'] });
  assert.deepEqual(spotTarget([runs[0], { ...runs[1], to: 1345 }]).expected.sort(), ['2', '5']);
  // Nothing long enough to be sure of.
  assert.equal(spotTarget([{ slot: 1, program: 'A', zone: '2', from: 1320, to: 1335 }]), null);
  assert.equal(eveningAt(runs), 1260);
  assert.equal(eveningAt([]), 21 * 60);
});

test('the evening check reports what keeps a night from running as planned', () => {
  const runs = [{ slot: 1, program: 'A', zone: '2', from: 1320, to: 1350 }];
  const matches = { state: 'matches', message: '' };
  const ready = {
    status: { controllerMode: 2, rainShutDown: 0 },
    codes: ['IFE', 'I01:01'],
    runs,
    planRuns: runs,
    sync: matches,
  };
  assert.deepEqual(eveningFindings(ready), []);

  const codes = input => eveningFindings({ ...ready, ...input }).map(f => [f.code, f.warn]);
  assert.deepEqual(codes({ status: { controllerMode: 1, rainShutDown: 0 } }), [['mode', true]]);
  assert.deepEqual(codes({ status: { controllerMode: 2 } }), [['rain-unknown', true]]);
  assert.deepEqual(codes({ codes: ['I01:02'] }), [['unsynced', true]]);
  assert.deepEqual(codes({ alarms: [{}] }), [['alarm', true]]);
  assert.deepEqual(codes({ sync: { state: 'controller changed', message: 'x' } }), [['changed', true]]);
  // A plan edited since the install isn't a problem for tonight; tonight's zones aren't compared then.
  assert.deepEqual(codes({ sync: { state: 'plan changed', message: 'x' }, planRuns: [] }), [['plan-changed', false]]);
  assert.deepEqual(codes({ planRuns: [{ ...runs[0], zone: '4' }] }), [['calendar', true]]);

  const held = eveningFindings({
    ...ready,
    status: { controllerMode: 2, rainShutDown: 7200 },
    firstStartInSeconds: 3600,
    rainSource: 'weather',
  });
  assert.deepEqual(held, [
    {
      code: 'rain',
      warn: false,
      held: true,
      skipped: ['2'],
      message: 'Held by 2core’s weather delay, 2 h left; zone 2 waits for the next date',
    },
  ]);
  // A delay ending during the night skips only the zones that start before it ends.
  const partial = eveningFindings({
    ...ready,
    runs: [
      ...runs,
      { slot: 1, program: 'A', zone: '7', from: 1350, to: 1380 },
      { slot: 2, program: 'B', zone: '4', from: 1390, to: 1400 },
    ],
    status: { controllerMode: 2, rainShutDown: 3600 + 40 * 60 },
    firstStartInSeconds: 3600,
  });
  assert.equal(partial[0].held, false);
  assert.deepEqual(partial[0].skipped, ['2', '7']);
  assert.equal(
    partial[0].message,
    'Held by a rain delay set outside 2core, 2 h left; zones 2, 7 wait for the next date, the rest run after it ends',
  );
  const ending = eveningFindings({
    ...ready,
    status: { controllerMode: 2, rainShutDown: 1800 },
    firstStartInSeconds: 3600,
  });
  assert.match(ending[0].message, /^A rain delay set outside 2core ends before the first start/);
});

test('the spot check tells a planned zone running from the wrong one or none', () => {
  const target = { zone: '5', expected: ['5', '2'] };
  const automatic = { controllerMode: 2, rainShutDown: 0 };
  assert.equal(spotOutcome(target, ['5'], automatic).outcome, 'seen running');
  assert.equal(spotOutcome(target, ['2'], automatic).outcome, 'seen running');
  assert.deepEqual(spotOutcome(target, ['9'], automatic), {
    outcome: 'running, not as planned',
    warn: true,
    message: 'Zone 9 was running instead of zone 5',
  });
  assert.equal(spotOutcome(target, [], automatic).outcome, 'not running when expected');
  assert.equal(spotOutcome(target, [], { controllerMode: 2, rainShutDown: 600 }).outcome, 'held by rain');
});

test('each night gets one status, most important first', () => {
  const runs = [{ zone: '2' }];
  const ok = { ok: true, findings: [] };
  assert.deepEqual(nightStatus({ runs }), { status: 'waiting', warn: false });
  assert.equal(nightStatus({ runs, closed: true }).status, 'not checked');
  assert.equal(nightStatus({ runs, evening: ok, target: {} }).status, 'ready');
  assert.equal(nightStatus({ runs, evening: ok, target: {}, closed: true }).status, 'ready, not seen running');
  assert.equal(nightStatus({ runs: [], evening: ok }).status, 'nothing planned');
  assert.equal(nightStatus({ runs, evening: ok, spot: { outcome: 'seen running' } }).status, 'seen running');
  assert.equal(nightStatus({ runs, evening: ok, spot: { outcome: 'not checked' } }).status, 'ready, not seen running');
  assert.deepEqual(nightStatus({ runs, evening: ok, spot: { outcome: 'not running when expected', warn: true } }), {
    status: 'not running when expected',
    warn: true,
  });
  assert.deepEqual(nightStatus({ runs, evening: { ok: true, findings: [{ code: 'mode', warn: true }] } }), {
    status: 'controller not ready',
    warn: true,
  });
  assert.equal(
    nightStatus({
      runs,
      evening: { ok: true, findings: [{ code: 'rain', warn: false, held: true, message: 'Held by x' }] },
    }).status,
    'held by rain',
  );
});

test('the app shows each night with its status and what was found', () => {
  assert.equal(
    nightClock(1530),
    new Date(2000, 0, 1, 1, 30).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  );
  const rows = nightRows(
    {
      nights: [
        {
          night: '2026-10-29',
          status: 'ready',
          warn: false,
          zones: 3,
          start: 1320,
          finish: 1500,
          eveningAt: null,
          target: { zone: '5', at: 1365 },
        },
        {
          night: '2026-10-28',
          status: 'not running when expected',
          warn: true,
          zones: 3,
          start: 1320,
          finish: 1500,
          spot: { message: 'Nothing was running' },
        },
        { night: '2026-10-20', status: 'not checked', warn: false, zones: 0 },
      ],
    },
    '2026-10-29',
  );
  assert.deepEqual(
    rows.map(r => [r.title, r.tone]),
    [
      ['Tonight', 'ok'],
      ['Last night', 'bad'],
      [new Date(2026, 9, 20).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), ''],
    ],
  );
  assert.match(rows[0].detail, /^3 zones, .* · looks for zone 5 at /);
  assert.match(rows[1].detail, /Nothing was running$/);
  assert.deepEqual(syncLine({ state: 'plan changed', message: 'm' }), ['m', 'warn']);
});

test('planNight reads the compiled plan’s calendar from its anchor', () => {
  const candidate = {
    status: 'candidate',
    calendarAnchor: '2026-10-29',
    programs: [{ slot: 1, clockMinute: 1350, calendarMask: days(1), steps: [{ zone: '4', seconds: 600 }] }],
  };
  assert.deepEqual(planNight(candidate, '2026-10-29'), []);
  assert.deepEqual(
    planNight(candidate, '2026-10-30').map(r => [r.zone, r.from]),
    [['4', 1350]],
  );
  assert.equal(planNight({ status: 'blocked' }, '2026-10-30'), null);
});

/** The demo controller with the plan installed, on a clock 2core's checks can move. */
async function installed(t) {
  const store = new Store();
  t.after(() => store.close());
  const driver = new DemoDriver();
  driver.delayMs = 0;
  const today = new Date();
  let minute = 12 * 60 + 30;
  const clock = () => new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() + minute * 60000;
  const engine = new Engine({ store, driver, clock });
  await engine.refresh();
  for (let zone = 1; zone <= 12; zone++)
    engine.intent(String(zone), { seconds: 1200 + zone * 60, cadence: { every: 1 } });
  const preview = engine.programInstallPreview();
  assert.equal(preview.status, 'ready', JSON.stringify(preview.issues));
  const result = await engine.programInstall({ token: preview.token });
  assert.equal(result.outcome, 'synced', JSON.stringify(result.problems));
  return { engine, driver, store, at: m => (minute = m), night: dateKey(today) };
}

test('the evening check reads the controller, then the spot check sees the planned zone running', async t => {
  const { engine, driver, at, night } = await installed(t);
  assert.equal(engine.state().nights.sync.state, 'matches');
  const tonight = engine.state().nights.nights[0];
  assert.equal(tonight.night, night);
  assert.equal(tonight.status, 'waiting');
  assert.ok(tonight.zones > 0 && tonight.eveningAt < tonight.start);

  // Before its time, nothing happens.
  at(tonight.eveningAt - 5);
  await engine.nightChecks.tick();
  assert.equal(engine.state().nights.nights[0].evening, null);

  at(tonight.eveningAt + 1);
  await engine.nightChecks.tick();
  let checked = engine.state().nights.nights[0];
  assert.equal(checked.status, 'ready', JSON.stringify(checked.evening));
  assert.deepEqual(checked.evening.findings, []);
  const target = checked.target;
  assert.ok(target.at > checked.start && target.at < checked.finish);

  at(target.at);
  driver.runs.push({ zone: target.zone, handle: 99, endsAt: Date.now() + 600000 });
  await engine.nightChecks.tick();
  checked = engine.state().nights.nights[0];
  assert.equal(checked.status, 'seen running');
  assert.deepEqual(checked.spot.running, [target.zone]);
  // Each check runs once.
  await engine.nightChecks.tick();
  assert.equal(engine.state().nights.nights[0].spot.at, checked.spot.at);
});

test('nothing running when a zone should be, or a missed check, is reported', async t => {
  const { engine, store, at } = await installed(t);
  const tonight = engine.state().nights.nights[0];
  at(tonight.eveningAt);
  await engine.nightChecks.tick();
  const target = engine.state().nights.nights[0].target;
  at(target.at + 1);
  await engine.nightChecks.tick();
  const night = engine.state().nights.nights[0];
  assert.deepEqual([night.status, night.warn], ['not running when expected', true]);
  assert.equal(store.events()[0].kind, 'night check');
  assert.equal(store.events()[0].data.outcome, 'warning');
});

test('a spot check past its time is marked not checked rather than run late', async t => {
  const { engine, at } = await installed(t);
  const tonight = engine.state().nights.nights[0];
  at(tonight.eveningAt);
  await engine.nightChecks.tick();
  at(engine.state().nights.nights[0].target.at + 30);
  await engine.nightChecks.tick();
  assert.equal(engine.state().nights.nights[0].status, 'ready, not seen running');
});

test('the evening check finds a rain delay and skips the spot check', async t => {
  const { engine, driver, at } = await installed(t);
  const tonight = engine.state().nights.nights[0];
  driver.rainUntil = Date.now() + 24 * 3600000;
  at(tonight.eveningAt);
  await engine.nightChecks.tick();
  const night = engine.state().nights.nights[0];
  assert.equal(night.status, 'held by rain');
  // No spot check on a held night.
  assert.equal(night.target, null);
});

test('a rain delay ending during the night skips the early zones and looks for a later one', async t => {
  const { engine, driver, at } = await installed(t);
  const tonight = engine.state().nights.nights[0];
  // The first start is an hour after the evening check; the delay ends half an hour after it.
  driver.rainUntil = Date.now() + 90 * 60000;
  at(tonight.eveningAt);
  await engine.nightChecks.tick();
  const night = engine.state().nights.nights[0];
  const rain = night.evening.findings.find(f => f.code === 'rain');
  assert.equal(rain.held, false);
  assert.ok(rain.skipped.length > 0 && rain.skipped.length < night.zones);
  assert.notEqual(night.status, 'held by rain');
  assert.ok(night.target && !rain.skipped.includes(night.target.zone));
});

test('the sync line tells a changed plan from programs changed outside 2core', async t => {
  const { engine, driver } = await installed(t);
  assert.equal(engine.state().nights.sync.state, 'matches');
  engine.intent('3', { seconds: 600 });
  assert.equal(engine.state().nights.sync.state, 'plan changed');
  engine.intent('3', { seconds: 1200 + 3 * 60 });
  assert.equal(engine.state().nights.sync.state, 'matches');

  driver.programs.list[0].waterBudget = '120';
  driver.readPrograms();
  await engine.refresh();
  engine.recordPrograms(driver.readPrograms());
  assert.equal(engine.state().nights.sync.state, 'controller changed');
});

test('without an install record, the baseline is taken when the controller holds the plan', async t => {
  const { engine, store } = await installed(t);
  store.set('programsInstalled', null);
  engine.nightChecks.cache = null;
  assert.equal(engine.state().nights.sync.state, 'matches');
  assert.equal(store.get('programsInstalled').kind, 'matched the plan');
});
