import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Engine, PROGRAM_TEST } from '../server/engine.mjs';
import { DemoDriver } from '../server/demo.mjs';
import { programDefinition, readProgram } from '../lib/programs.mjs';

async function fixture(t, options = {}) {
  const store = new Store();
  t.after(() => store.close());
  const driver = new DemoDriver();
  const engine = new Engine({ store, driver, ...options });
  await engine.refresh();
  return { engine, driver, store };
}
const slot = driver => driver.programs.list.find(p => Number(p.ID) === PROGRAM_TEST.slot);

test('the test write leaves its slot off with one zone for a minute, syncs it, and the restore puts it back', async t => {
  const { engine, driver } = await fixture(t);
  const before = structuredClone(slot(driver));
  const sent = [];
  const write = driver.writePrograms.bind(driver);
  driver.writePrograms = messages => {
    sent.push(...messages);
    write(messages);
  };

  const result = await engine.programTest();
  assert.equal(result.outcome, 'synced', JSON.stringify(result.problems));
  assert.equal(driver.synced, true);
  const after = readProgram(slot(driver));
  assert.equal(after.active, false);
  assert.deepEqual(after.steps, [{ zone: '2', seconds: 60 }]);
  assert.deepEqual(after.starts, [{ minute: 1380, cycles: 1, finish: 1381 }]);
  assert.equal(after.budget, 100);
  assert.equal(slot(driver).fullDaySchedule.replace(/-/g, '').length, 2);
  // Nothing turns the slot on, and the zones it held are zeroed rather than deleted.
  assert.ok(!sent.some(m => m.Status === 1));
  assert.deepEqual(
    sent.filter(m => m.Type === 'IrrPgmCont').map(m => [m.Seq, m.RunTime]),
    [
      [2, 60],
      [5, 0],
      [9, 0],
    ],
  );
  const record = engine.programs().tests[0];
  assert.equal(record.kind, 'test write');
  assert.equal(record.outcome, 'synced');
  assert.deepEqual(record.messages, sent);
  assert.deepEqual(record.sync.problems, []);

  // Running it again the same day finds the test already in place and synced.
  assert.equal((await engine.programTest()).outcome, 'nothing to change');

  const restored = await engine.programRestore();
  assert.equal(restored.outcome, 'synced', JSON.stringify(restored.problems));
  assert.deepEqual(programDefinition([slot(driver)]), programDefinition([before]));
  assert.equal((await engine.programRestore()).outcome, 'nothing to change');
  assert.deepEqual(
    engine.programs().tests.map(r => r.outcome),
    ['nothing to change', 'synced', 'nothing to change', 'synced'],
  );
});

test('the test write refuses a slot that is on, has days, or changed, and sends nothing', async t => {
  const { engine, driver, store } = await fixture(t);
  let writes = 0;
  driver.writePrograms = () => writes++;
  slot(driver).status = '1';
  await assert.rejects(engine.programTest(), /changed since 2core first saw it/);
  slot(driver).status = '0';
  slot(driver).fullDaySchedule = '-M------------';
  await assert.rejects(engine.programTest(), /changed since 2core first saw it/);
  slot(driver).fullDaySchedule = '--------------';
  slot(driver).waterBudget = '90';
  await assert.rejects(engine.programTest(), /changed since 2core first saw it/);
  slot(driver).waterBudget = '150';
  // Restoring a slot someone turned on would turn it off behind their back.
  slot(driver).status = '1';
  await assert.rejects(engine.programRestore(), /turned on since the test/);
  slot(driver).status = '0';
  // A slot that was already on when 2core first saw it is never a test slot.
  const saved = store.get('programsOriginal');
  saved.list.find(p => Number(p.ID) === PROGRAM_TEST.slot).status = '1';
  store.set('programsOriginal', saved);
  slot(driver).status = '1';
  await assert.rejects(engine.programTest(), /on or has watering days/);
  assert.equal(writes, 0);
  assert.equal(engine.programs().tests[0].outcome, 'not sent');
});

test('a calendar that doesn’t start today blocks the write', async t => {
  const { engine, driver } = await fixture(t);
  const read = driver.readPrograms.bind(driver);
  driver.readPrograms = () => {
    const programs = read();
    for (const p of programs.list) p.allDaysArranged = 'SMtWTFsSMtWTFs'.slice(1) + 'S';
    return programs;
  };
  await assert.rejects(engine.programTest(), /calendar doesn’t start today/);
});

test('program writes need live control and their own flag outside the demo', async t => {
  for (const options of [{ allowControl: false, allowProgramWrites: true }, { allowControl: true }]) {
    const { engine } = await fixture(t, { mode: 'live', ...options });
    await assert.rejects(engine.programTest(), /disabled|Program writes are off/);
    await assert.rejects(engine.programRestore(), /disabled|Program writes are off/);
    assert.equal(engine.programs().writesEnabled, false);
  }
  const { engine } = await fixture(t, { mode: 'live', allowControl: true, allowProgramWrites: true });
  assert.equal(engine.programs().writesEnabled, true);
});

test('a first copy read on another day still matches an unchanged slot', async t => {
  const { engine, store } = await fixture(t);
  // Production’s first copy was read on a Wednesday; its day letters started there.
  const saved = store.get('programsOriginal');
  for (const p of saved.list) p.allDaysArranged = 'WTFsSMtWTFsSMt';
  store.set('programsOriginal', saved);
  assert.equal((await engine.programTest()).outcome, 'synced');
});

test('a write waiting in Tucor’s cloud is synced without writing it again', async t => {
  const { engine, driver } = await fixture(t);
  const execute = driver.syncProposal.bind(driver);
  // The first run's sync is blocked, so the write stays in the cloud.
  driver.syncProposal = () => ({ ...execute(), records: [] });
  const first = await engine.programTest();
  assert.equal(first.outcome, 'not synced');
  assert.deepEqual(first.problems, ['Tucor didn’t say what a sync would change.']);
  assert.equal(driver.synced, false);
  driver.syncProposal = execute;
  let writes = 0;
  const write = driver.writePrograms.bind(driver);
  driver.writePrograms = messages => {
    writes += messages.length;
    write(messages);
  };
  const second = await engine.programTest();
  assert.equal(second.outcome, 'synced');
  assert.equal(writes, 0);
  assert.equal(driver.synced, true);
});

test('a sync that would touch anything but programs, or go the other way, never runs', async t => {
  const { engine, driver } = await fixture(t);
  let executed = 0;
  const proposal = driver.syncProposal.bind(driver);
  driver.syncProposal = () => {
    const p = proposal();
    p.records[0].useappdata = '1';
    return p;
  };
  const session = driver.withSession.bind(driver);
  driver.withSession = fn =>
    session(s =>
      fn({
        ...s,
        codes: s.codes,
        executeSync: async () => {
          executed++;
        },
      }),
    );
  const result = await engine.programTest();
  assert.equal(result.outcome, 'not synced');
  assert.deepEqual(result.problems, ['Stations would sync too.']);
  assert.equal(executed, 0);
});
