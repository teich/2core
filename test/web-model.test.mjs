// The web app's pure logic (web/model, web/core/format), tested without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, clock, day, duration, hm, hoursLeft } from '../web/core/format.js';
import {
  blockedReason,
  canControl,
  describe,
  dialSteps,
  filterZones,
  lastRuns,
  levelOf,
  nextZone,
  opTarget,
  operationLabel,
  pendingOp,
  stepIndex,
  zoneMode,
} from '../web/model/zones.js';
import { because, decisionSummary, depth, rainDelay, rainUnit, stationHealth } from '../web/model/weather.js';
import { connectionStatus } from '../web/model/connection.js';

const NOW = Date.parse('2026-07-01T20:00:00Z');
const zone = (id, extra = {}) => ({
  id,
  name: `Zone ${id}`,
  notes: '',
  order: Number(id),
  configured: true,
  running: false,
  owned: false,
  favorite: false,
  ...extra,
});
const state = (extra = {}) => ({
  zones: [zone('1'), zone('2'), zone('3')],
  operations: [],
  events: [],
  status: { rainShutDown: 0 },
  available: true,
  controlEnabled: true,
  mode: 'live',
  observedAt: new Date(NOW - 5000).toISOString(),
  policy: {
    mode: 'observe',
    holdHours: 24,
    intensityMmH: 2,
    accumulationMm: 5,
    forecastMm: 6,
    forecastProbability: 60,
  },
  ...extra,
});
const ctx = (extra = {}) => ({
  state: state(),
  reachable: true,
  busy: false,
  tracked: null,
  failure: null,
  now: NOW,
  ...extra,
});
const ownedRun = minutesLeft =>
  zone('2', {
    running: true,
    owned: true,
    minutes: 10,
    startedAt: new Date(NOW - (10 - minutesLeft) * 60000).toISOString(),
    endsAt: new Date(NOW + minutesLeft * 60000).toISOString(),
  });

test('format: countdowns, durations and relative days', () => {
  assert.equal(clock(65_000), '1:05');
  assert.equal(clock(3_725_000), '1:02:05');
  assert.equal(clock(-5), '0:00');
  assert.equal(hm(95), '1:35');
  assert.equal(duration(45), '45 min');
  assert.equal(duration(60), '1 h');
  assert.equal(duration(90), '1 h 30 min');
  assert.equal(hoursLeft(7200), '2 h');
  assert.equal(hoursLeft(61), '2 min');
  assert.equal(ago(new Date(NOW - 12_000).toISOString(), NOW), '12 s ago');
  assert.equal(ago(new Date(NOW - 3 * 3600_000).toISOString(), NOW), '3 h ago');
  assert.equal(ago('not a date', NOW), 'never');
  assert.equal(day(new Date(NOW).toISOString(), NOW), 'today');
  assert.equal(day(new Date(NOW - 864e5).toISOString(), NOW), 'yesterday');
});

test('zone modes follow confirmed state, pending commands and failures', () => {
  assert.equal(zoneMode(undefined, ctx()), 'idle');
  assert.equal(zoneMode(zone('1'), ctx()), 'idle');
  assert.equal(zoneMode(zone('1'), ctx({ reachable: false })), 'offline');
  assert.equal(zoneMode(zone('1'), ctx({ state: state({ available: false }) })), 'stale');
  assert.equal(zoneMode(ownedRun(5), ctx()), 'running');
  // A run started elsewhere has no trustworthy end time.
  assert.equal(zoneMode(zone('2', { running: true }), ctx()), 'unknown');

  const pending = kind => ({ id: 'op', kind, body: { minutes: 5 }, state: 'pending', phase: 'queued' });
  const withOp = kind => ctx({ state: state({ operations: [pending(kind)] }) });
  assert.equal(zoneMode(zone('1'), withOp('/api/zones/1/start')), 'starting');
  assert.equal(zoneMode(zone('2'), withOp('/api/zones/1/start')), 'idle');
  assert.equal(zoneMode(ownedRun(5), withOp('/api/stop')), 'stopping');
  // "Next" stops the owned run before starting the next zone.
  assert.equal(zoneMode(ownedRun(5), withOp('/api/zones/3/next')), 'stopping');

  const failure = { zone: '1', action: 'start', message: 'Timed out', at: NOW - 1000 };
  assert.equal(zoneMode(zone('1'), ctx({ failure })), 'failed');
  assert.equal(zoneMode(zone('1'), ctx({ failure, now: NOW + 10_000 })), 'idle');
  assert.equal(describe(zone('1'), 'failed', ctx({ failure })).text, 'Didn’t start: Timed out');
});

test('a command this browser sent counts as pending until the server lists it', () => {
  const tracked = { id: 'mine', kind: '/api/zones/3/start', body: { minutes: 2 }, deadline: '', accepted: false };
  const c = ctx({ tracked });
  assert.deepEqual(pendingOp(c), {
    kind: '/api/zones/3/start',
    body: { minutes: 2 },
    phase: 'sending',
    acceptedAt: new Date(NOW).toISOString(),
  });
  assert.equal(zoneMode(zone('3'), c), 'starting');
  assert.equal(canControl(c), false);
  assert.match(blockedReason(c), /still being handled/);
});

test('starting is blocked by rain delays, other runs and read-only servers', () => {
  assert.equal(blockedReason(ctx()), '');
  assert.match(blockedReason(ctx({ reachable: false })), /reach/);
  assert.match(blockedReason(ctx({ state: state({ controlEnabled: false }) })), /Read-only/);
  assert.match(blockedReason(ctx({ state: state({ status: { rainShutDown: 600 } }) })), /Rain delay/);
  assert.match(blockedReason(ctx({ state: state({ zones: [ownedRun(3)] }) })), /Another zone/);
});

test('vessel level tracks time left, and never invents progress for unknown runs', () => {
  assert.equal(levelOf(ownedRun(5), 'running', NOW), 0.5);
  assert.equal(levelOf(ownedRun(10), 'running', NOW), 1);
  assert.equal(levelOf(zone('2', { running: true }), 'unknown', NOW), 0.5);
  assert.equal(levelOf(zone('1'), 'idle', NOW), 0);
});

test('operations are labelled and targeted for status messages', () => {
  const zones = [zone('4', { name: 'Roses' })];
  assert.equal(
    operationLabel({ kind: '/api/zones/4/start', body: { minutes: 90 } }, zones),
    'Start Roses for 1 h 30 min',
  );
  assert.equal(
    operationLabel({ kind: '/api/zones/9/next', body: { minutes: 1 } }, zones),
    'Stop and start zone 9 for 1 min',
  );
  assert.equal(operationLabel({ kind: '/api/rain', body: { hours: 0 } }), 'Clear rain delay');
  assert.equal(operationLabel({ kind: '/api/zones/4/preferences', body: { issues: [] } }), 'Save flag');
  assert.deepEqual(opTarget({ kind: '/api/zones/4/next' }), { zone: '4', action: 'start', next: true });
  assert.equal(opTarget({ kind: '/api/rain' }), null);
});

test('zone search, filters, walking order and the minute dial', () => {
  const zones = [
    zone('1', { name: 'Front lawn', favorite: true }),
    zone('2', { name: 'Roses', notes: 'drip line' }),
    zone('3', { configured: false }),
  ];
  const ids = list => list.map(z => z.id);
  assert.deepEqual(ids(filterZones(zones, {})), ['1', '2']);
  assert.deepEqual(ids(filterZones(zones, { showUnused: true })), ['1', '2', '3']);
  assert.deepEqual(ids(filterZones(zones, { query: '02' })), ['2']);
  assert.deepEqual(ids(filterZones(zones, { query: 'DRIP' })), ['2']);
  assert.deepEqual(ids(filterZones(zones, { favorites: true })), ['1']);
  assert.equal(nextZone(zones, '3').id, '1');

  const steps = dialSteps({ minMinutes: 1, maxMinutes: 240 });
  assert.equal(steps.length, 59 + 37);
  assert.deepEqual(steps.slice(58, 62), [59, 60, 65, 70]);
  assert.equal(steps[stepIndex(steps, 62)], 60);

  const events = [
    { kind: '/api/zones/2/start', at: 'b', data: { outcome: 'confirmed', minutes: 5 } },
    { kind: '/api/zones/2/start', at: 'a', data: { outcome: 'confirmed', minutes: 9 } },
    { kind: '/api/zones/1/next', at: 'c', data: { outcome: 'failed', minutes: 1 } },
  ];
  assert.deepEqual(lastRuns(events), { 2: { at: 'b', minutes: 5 } });
});

test('rain depths respect the station unit and show traces', () => {
  assert.equal(rainUnit(state(), 'en-US'), 'in');
  assert.equal(rainUnit(state(), 'en-GB'), 'mm');
  assert.equal(rainUnit(state({ weatherReading: { sample: { unit: 'mm' } } }), 'en-US'), 'mm');
  assert.equal(depth(0.1, 'in'), '<0.01');
  assert.equal(depth(25.4, 'in'), '1.00');
  assert.equal(depth(0, 'mm', false), '0.1');
  assert.equal(depth(12.6, 'mm'), '13');
  assert.equal(because('Wet', { kind: 'intensity', mm: 2 }, 'mm'), 'Raining 2.0 mm/h');
  assert.equal(because('Manual', null, 'mm'), 'Manual');
});

test('a rain delay is ours only when it matches the one 2core set', () => {
  const observedAt = new Date(NOW).toISOString();
  const until = new Date(NOW + 12 * 3600_000).toISOString();
  const delay = rain => rainDelay(state({ observedAt, status: { rainShutDown: 12 * 3600 }, rain }), 'mm', NOW);
  assert.equal(delay({ until, hours: 12, source: 'manual' }).meter, 100);
  assert.match(delay({ until, hours: 12, source: 'manual' }).detail, /Set from 2core/);
  assert.match(delay(null).detail, /Set at the controller/);
  assert.equal(delay(null).meter, null);
  assert.equal(rainDelay(state(), 'mm', NOW).title, 'Off');
});

test('station health and the latest decision read clearly', () => {
  const source = { configured: true, source: 'Tempest', station: { id: '42' } };
  const reading = { at: new Date(NOW - 60_000).toISOString(), sample: {} };
  assert.deepEqual(stationHealth(state(), NOW).pill, ['Not set up', '']);
  assert.deepEqual(stationHealth(state({ weatherSource: source, weatherReading: reading }), NOW).pill, [
    'Live · 1 min ago',
    'ok',
  ]);
  const failing = { ...reading, error: 'WeatherFlow HTTP 500', errorAt: new Date(NOW).toISOString() };
  assert.deepEqual(stationHealth(state({ weatherSource: source, weatherReading: failing }), NOW).pill, [
    'Can’t connect',
    'bad',
  ]);

  const decided = d =>
    decisionSummary(state({ weatherSource: source, weatherDecision: { at: reading.at, ...d } }), 'mm', NOW);
  assert.equal(decided({ wet: false, reason: 'Dry' }).tone, 'leaf');
  assert.equal(decided({ wet: true, reason: 'Wet', applied: true }).title, 'Set a 24 h delay');
  assert.match(decided({ wet: true, reason: 'Wet', blocked: 'off' }).detail, /Live control is off/);
  assert.equal(decided({ wet: false, reason: 'Rain delay not set: busy' }).title, 'Couldn’t set a delay');
});

test('the connection pill says how live the view is', () => {
  assert.deepEqual(connectionStatus(ctx({ reachable: false })), ['Offline', 'bad']);
  assert.deepEqual(connectionStatus(ctx({ state: state({ mode: 'demo' }) })), ['Simulation', '']);
  assert.deepEqual(connectionStatus(ctx({ state: state({ connection: { open: true } }) })), [
    'Connected · 5 s ago',
    '',
  ]);
  assert.deepEqual(connectionStatus(ctx({ state: state({ available: false, observedAt: undefined }) })), [
    'Paused · tap to check',
    'stale',
  ]);
});

test('plan text: night clock, compact durations and the run-length stepper', async () => {
  const { clampPercent, clockAt, clockShort, consequenceText, editLines, nightLabel, shortSeconds, stepMinutes } =
    await import('../web/model/plan.js');
  assert.equal(clockAt(22 * 60), '10:00pm');
  assert.equal(clockAt(1440), 'midnight');
  assert.equal(clockAt(1440 + 6 * 60 + 5), '6:05am');
  assert.equal(clockShort(22 * 60), '10pm');
  assert.equal(shortSeconds(45), '45s');
  assert.equal(shortSeconds(720), '12');
  assert.equal(shortSeconds(750), '12:30');
  assert.equal(shortSeconds(3900), '1h05');
  assert.equal(stepMinutes(8, 1), 9);
  assert.equal(stepMinutes(10, 1), 15);
  assert.equal(stepMinutes(10, -1), 9);
  assert.equal(stepMinutes(60, 1), 75);
  assert.equal(stepMinutes(240, 1), 240);
  assert.equal(stepMinutes(1, -1), 1);
  assert.equal(clampPercent(250), 200);
  assert.equal(clampPercent(49.4), 50);
  const start = new Date(2026, 6, 1);
  assert.equal(nightLabel(start, 0), 'Tonight');
  assert.equal(nightLabel(start, 1), 'Tomorrow');
  assert.equal(nightLabel(start, 3), 'Sat 4');

  const saved = { 4: { seconds: 600, enabled: true } };
  assert.deepEqual(
    editLines(
      {
        intents: { 4: { seconds: 900, enabled: false } },
        settings: { lanes: 2, earliestStart: 1320 },
        rebalanceToken: 't',
      },
      saved,
      id => `Zone ${id}`,
    ),
    [
      ['Zone 4', 'run length 10 min → 15 min'],
      ['Zone 4', 'watering on → off'],
      ['Night', 'zones at once → up to two'],
      ['Night', 'start after 10:00pm'],
      ['Dates', 'apply the reviewed rebalance'],
    ],
  );
  assert.equal(consequenceText({}), '');
  assert.equal(
    consequenceText({ laterFinishNights: 1, latestFinish: 1440 + 330 }),
    'Finishes later on 1 night; latest 5:30am.',
  );
});
