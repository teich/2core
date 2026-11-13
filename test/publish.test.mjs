import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planChanges, publishImpact, wateringPlan } from '../lib/publish.mjs';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { DemoDriver } from '../server/demo.mjs';
import { DEFAULT_SETTINGS } from '../lib/planner.mjs';
import { editLines, minuteLines, nightLines, publishBar, windowNote } from '../web/model/publish.js';

const intent = extra => ({ seconds: 1200, cadence: { every: 2 }, enabled: true, firstDue: '2026-11-13', ...extra });

test('only complete intentions and night settings count as a change to publish', () => {
  const published = { settings: DEFAULT_SETTINGS, intents: { 1: intent(), 2: { seconds: null } }, seasonalZoneIds: [] };
  // A comparison-zone choice or an unfinished zone doesn't reach the programs.
  assert.deepEqual(
    wateringPlan({ ...published, seasonalZoneIds: ['4'], intents: { ...published.intents, 3: { seconds: 60 } } }),
    wateringPlan(published),
  );
  const saved = {
    settings: { ...DEFAULT_SETTINGS, lanes: 1 },
    intents: { 1: intent({ seconds: 1500 }), 2: intent({ cadence: { perWeek: 2 } }), 3: intent({ enabled: false }) },
  };
  assert.deepEqual(planChanges(published, saved), {
    zones: [
      { zone: '1', fields: [{ field: 'seconds', before: 1200, after: 1500 }] },
      { zone: '2', added: true, fields: [] },
      { zone: '3', added: true, fields: [] },
    ],
    settings: [{ field: 'lanes', before: 2, after: 1 }],
  });
  assert.deepEqual(planChanges(saved, published).zones.at(-1), { zone: '3', removed: true, fields: [] });
});

test('the impact compares each night and minutes a week per zone', () => {
  const run = (zone, from, to) => ({ slot: 1, program: 'A', zone, from, to });
  const nights = Array.from({ length: 14 }, (_, d) => ({
    night: `n${d}`,
    before: d % 2 ? [] : [run('1', 1320, 1340)],
    after: d % 2 ? [] : [run('1', 1320, 1345), run('2', 1345, 1355)],
  }));
  const impact = publishImpact(nights);
  assert.deepEqual(impact.zones, [
    { zone: '1', before: 70, after: 88 },
    { zone: '2', before: 0, after: 35 },
  ]);
  assert.deepEqual(impact.nights[0], {
    night: 'n0',
    before: { zones: ['1'], start: 1320, finish: 1340 },
    after: { zones: ['1', '2'], start: 1320, finish: 1355 },
    changed: true,
  });
  assert.equal(impact.nights[1].changed, false);
});

/** A demo engine at 12:30 today that has published a plan of twelve daily zones. */
async function published(t, options = {}) {
  const store = new Store();
  t.after(() => store.close());
  const driver = new DemoDriver();
  driver.delayMs = 0;
  const today = new Date();
  let minute = 12 * 60 + 30;
  const clock = () => new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() + minute * 60000;
  const engine = new Engine({ store, driver, clock, ...options });
  await engine.refresh();
  for (let zone = 1; zone <= 12; zone++)
    engine.intent(String(zone), { seconds: 1200 + zone * 60, cadence: { every: 1 } });
  const preview = engine.programInstallPreview();
  assert.equal(preview.status, 'ready', JSON.stringify(preview.issues));
  assert.equal((await engine.programInstall({ token: preview.token })).outcome, 'synced');
  return { engine, store, at: m => (minute = m) };
}

test('edits since the last publish are listed, reviewed and can be discarded', async t => {
  const { engine } = await published(t);
  assert.equal(engine.state().publish.state, 'matches');
  assert.deepEqual(engine.state().publish.edits, { zones: [], settings: [] });

  engine.intent('3', { seconds: 600 });
  const state = engine.state().publish;
  assert.equal(state.state, 'plan changed');
  assert.deepEqual(state.edits.zones, [{ zone: '3', fields: [{ field: 'seconds', before: 1380, after: 600 }] }]);

  const review = engine.programInstallPreview();
  assert.deepEqual(review.edits, state.edits);
  const zone3 = review.impact.zones.find(z => z.zone === '3');
  assert.equal(zone3.before, 23 * 7);
  assert.equal(zone3.after, 10 * 7);
  assert.equal(review.impact.nights.length, 14);
  assert.equal(review.window.open, true);

  assert.throws(() => engine.planDiscard({ token: 'stale' }), /look again/);
  engine.planDiscard({ token: state.token });
  assert.equal(engine.state().plan.intents['3'].seconds, 1380);
  assert.equal(engine.state().publish.state, 'matches');
});

test('a rename keeps the published plan; putting programs back leaves it unpublished', async t => {
  const { engine } = await published(t);
  engine.nightChecks.installed('rename programs');
  assert.equal(engine.state().publish.state, 'matches');
  // The demo's programs from before the install aren't the plan.
  assert.equal((await engine.programRestoreInstall({})).outcome, 'synced');
  const state = engine.state().publish;
  assert.equal(state.state, 'plan changed');
  assert.match(state.message, /aren’t the saved plan/);
  assert.equal(state.edits, null);
});

test('publishing waits while tonight’s programs are due or running', async t => {
  const { engine, at } = await published(t, { guardWateringWindow: true });
  engine.intent('3', { seconds: 600 });
  const { window } = engine.state().publish;
  assert.ok(window.closesAt && window.opensAt);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const minuteOf = iso => (Date.parse(iso) - midnight.getTime()) / 60000;
  at(minuteOf(window.closesAt) + 1);
  const review = engine.programInstallPreview();
  assert.equal(review.window.open, false);
  await assert.rejects(engine.programInstall({ token: review.token }), /Nothing was sent/);
  // After the last zone finishes, it goes ahead.
  at(minuteOf(window.opensAt));
  const after = engine.programInstallPreview();
  assert.equal(after.window.open, true);
});

test('the app words the edits, the nights and the publish bar', () => {
  const names = { 1: 'Rear lawn', 2: 'Citrus' };
  const edits = {
    zones: [
      { zone: '1', fields: [{ field: 'seconds', before: 1200, after: 1500 }] },
      { zone: '2', added: true, fields: [] },
    ],
    settings: [{ field: 'lanes', before: 2, after: 1 }],
  };
  assert.deepEqual(editLines(edits, names, { 2: { seconds: 600, cadence: { every: 3 } } }), [
    { title: 'Zones at once', detail: '2 → 1' },
    { title: 'Rear lawn', detail: '20 min → 25 min' },
    { title: 'Citrus', detail: 'Now planned: 10 min, every 3 days' },
  ]);
  const impact = {
    nights: [
      {
        night: '2026-11-14',
        before: { zones: ['1'], start: 1320, finish: 1340 },
        after: { zones: ['1', '2'], start: 1320, finish: 1350 },
        changed: true,
      },
      { night: '2026-11-15', before: { zones: [] }, after: { zones: [] }, changed: false },
    ],
    zones: [
      { zone: '1', before: 70, after: 70 },
      { zone: '2', before: 0, after: 35 },
    ],
  };
  assert.deepEqual(nightLines(impact, names), [
    { title: 'Sat Nov 14', detail: 'adds Citrus · 10:00pm–10:20pm → 10:00pm–10:30pm' },
  ]);
  assert.deepEqual(minuteLines(impact, names), [{ title: 'Citrus', detail: '0 → 35 min a week' }]);

  const day = () => 'Oct 28';
  assert.equal(publishBar({ state: 'matches', since: 'x' }, day).detail, 'Published Oct 28');
  const bar = publishBar({ state: 'plan changed', edits, message: 'm', since: 'x' }, day);
  assert.equal(bar.title, '3 changes not published');
  assert.equal(bar.detail, 'Last published Oct 28');
  assert.equal(bar.action, 'Review and publish');
  assert.equal(publishBar({ state: 'controller changed', message: 'm' }, day).tone, 'bad');
  assert.equal(publishBar(undefined, day), null);

  const now = Date.parse('2026-11-13T12:00:00');
  const window = { open: true, closesAt: '2026-11-13T21:44:00', opensAt: '2026-11-14T06:30:00' };
  assert.match(windowNote(window, now), /^Publish before/);
  assert.match(windowNote({ ...window, open: false }, now), /opens again/);
  assert.equal(windowNote({ open: true, closesAt: null }), '');
});
