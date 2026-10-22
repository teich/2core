import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { programDefinition, readCapabilities, readProgram } from '../lib/programs.mjs';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { DemoDriver } from '../server/demo.mjs';

const captured = JSON.parse(readFileSync(new URL('./fixtures/tucor-programs.json', import.meta.url), 'utf8'));

test('captured Tucor programs read into starts, steps, days and budget', () => {
  const programs = captured.programs.data.map(readProgram);
  assert.equal(programs.length, 10);
  const back = programs.find(p => p.id === '7');
  assert.equal(back.name, 'Prog 7');
  assert.equal(back.active, false);
  assert.equal(back.period, 'Even');
  assert.deepEqual(back.starts, [{ minute: 240, cycles: 1, finish: 403 }]);
  assert.equal(back.steps.length, 11);
  assert.deepEqual(back.steps[0], { zone: '17', seconds: 2400 });
  const fruit = programs.find(p => p.id === '8');
  assert.equal(fruit.active, true);
  assert.equal(fruit.budget, 120);
  assert.equal(fruit.adjustedSeconds, 2520);
  assert.deepEqual(
    fruit.days.flatMap((on, i) => (on ? [i] : [])),
    [0, 4, 7, 10],
  );
  // An inactive start reports no finish.
  assert.equal(programs[0].starts[0].finish, null);
});

test('capabilities keep the limits that matter for writing programs', () => {
  const c = readCapabilities(captured.capabilities.Capabilities);
  assert.equal(c.maxStarts, 12);
  assert.equal(c.maxStationsPerStep, 1);
  assert.equal(c.deleteStep, false);
  assert.equal(c.allowPeriodChange, true);
  assert.equal(c.nameLength, 12);
  assert.deepEqual(c.budget, { minimum: 0, maximum: 250 });
  assert.deepEqual(
    c.periods.map(p => p.label),
    ['14 days', 'Odd', 'Even'],
  );
  assert.equal(readCapabilities(null), null);
});

test('program definitions ignore running state and the swapped 14-day window', () => {
  const later = captured.programs.data;
  const earlier = captured.earlier.data;
  assert.notDeepEqual(
    earlier.map(p => p.fullDaySchedule),
    later.map(p => p.fullDaySchedule),
  );
  assert.deepEqual(programDefinition(earlier), programDefinition(later));
  const edited = structuredClone(later);
  edited[0].steps[0].runtime = '420';
  assert.notDeepEqual(programDefinition(edited), programDefinition(later));
});

function engineWith(t) {
  const store = new Store();
  t.after(() => store.close());
  const engine = new Engine({ store, driver: new DemoDriver() });
  return { engine, store };
}
const observation = (list, receivedAt, capabilities = captured.capabilities.Capabilities) => ({
  controller: null,
  stations: [],
  status: {},
  receivedAt,
  programs: { capabilities, list, receivedAt },
});

test('the first copy of the programs is kept as the original; later copies replace the latest', t => {
  const { engine, store } = engineWith(t);
  engine.accept(observation(captured.earlier.data, '2026-09-27T10:00:00.000Z'));
  engine.accept(observation(captured.programs.data, '2026-09-27T10:01:00.000Z', null));
  const edited = structuredClone(captured.programs.data);
  edited[3].starts[0].starttime = '300';
  engine.accept(observation(edited, '2026-09-28T10:00:00.000Z', null));

  const result = engine.programs();
  assert.equal(result.observedAt, '2026-09-28T10:00:00.000Z');
  assert.equal(result.programs.find(p => p.id === '4').starts[0].minute, 300);
  assert.equal(result.capabilities.maxStarts, 12, 'capabilities carry over when a packet lacks them');
  assert.equal(result.backups.original.receivedAt, '2026-09-27T10:00:00.000Z');
  assert.equal(result.backups.original.list[3].starts[0].starttime, '240');
  // Only the real edit is reported, not the swapped window.
  assert.deepEqual(
    store.events().map(e => [e.kind, e.data.outcome]),
    [['controller programs', 'changed']],
  );
  // Programs stay out of the stored observation that /api/state is built from.
  assert.equal(store.get('lastObservation').programs, undefined);
});

test('without a controller reading there are no programs', t => {
  const { engine } = engineWith(t);
  assert.deepEqual(engine.programs(), {
    observedAt: null,
    capabilities: null,
    programs: [],
    backups: { latest: null, original: null },
  });
});
