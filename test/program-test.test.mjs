import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { Engine, PROGRAM_TEST } from '../server/engine.mjs';
import { DemoDriver } from '../server/demo.mjs';
import { programDefinition, readProgram } from '../lib/programs.mjs';
import { readbackProblems } from '../lib/program-messages.mjs';

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

// A plan for the demo's twelve zones: every other day, so it compiles into two programs.
async function planned(t) {
  const f = await fixture(t);
  for (let zone = 1; zone <= 12; zone++)
    f.engine.intent(String(zone), { seconds: 300 + zone * 60, cadence: { every: 2 } });
  await f.engine.refresh();
  return f;
}

test('installing a reviewed plan writes every slot, syncs, and can be put back from its backup', async t => {
  const { engine, driver } = await planned(t);
  const before = structuredClone(driver.programs.list);
  const preview = engine.programInstallPreview();
  assert.equal(preview.status, 'ready', JSON.stringify(preview.issues));
  const result = await engine.programInstall({ token: preview.token });
  assert.equal(result.outcome, 'synced', JSON.stringify(result.problems));
  assert.equal(driver.synced, true);
  // Every slot now holds what the review showed.
  for (const p of preview.programs)
    assert.deepEqual(
      readbackProblems(
        driver.programs.list.find(r => Number(r.ID) === p.slot),
        p.target,
      ),
      [],
    );
  const used = preview.programs.filter(p => p.use === 'plan');
  assert.equal(used.length, 2);
  assert.ok(used.every(p => readProgram(driver.programs.list.find(r => Number(r.ID) === p.slot)).active));
  const { installBackups, tests } = engine.programs();
  assert.equal(installBackups.length, 1);
  assert.equal(tests[0].kind, 'install plan');
  assert.deepEqual(
    tests[0].slots.map(s => s.slot),
    [1, 2, 3, 4, 5],
  );

  // Installing the same review again finds nothing to change.
  assert.equal(
    (await engine.programInstall({ token: engine.programInstallPreview().token })).outcome,
    'nothing to change',
  );

  const restored = await engine.programRestoreInstall();
  assert.equal(restored.outcome, 'synced', JSON.stringify(restored.problems));
  assert.deepEqual(programDefinition(driver.programs.list), programDefinition(before));
});

test('an install needs a current review and nothing running, and refuses before sending', async t => {
  const { engine, driver } = await planned(t);
  let writes = 0;
  driver.writePrograms = () => writes++;
  await assert.rejects(engine.programInstall({}), /Review the install first/);
  const { token } = engine.programInstallPreview();
  engine.intent('3', { seconds: 900 });
  const sessions = driver.withSession.bind(driver);
  let opened = 0;
  driver.withSession = fn => {
    opened++;
    return sessions(fn);
  };
  await assert.rejects(engine.programInstall({ token }), /changed since the review/);
  // A stale review is refused without contacting Tucor.
  assert.equal(opened, 0);
  driver.withSession = sessions;
  const fresh = engine.programInstallPreview();
  await engine.start('4', 1);
  await assert.rejects(engine.programInstall({ token: fresh.token }), /A zone is running/);
  await engine.stop('4');
  await assert.rejects(engine.programRestoreInstall(), /No install has been made/);
  assert.equal(writes, 0);
  assert.equal(engine.programs().installBackups.length, 0);
});

test('an install cut off partway is left unknown, says how far it got, and keeps its backup', async t => {
  const { engine, driver } = await planned(t);
  const write = driver.writePrograms.bind(driver);
  let calls = 0;
  driver.writePrograms = messages => {
    if (++calls === 2) throw new Error('Tucor connection lost; command outcome may be unknown');
    write(messages);
  };
  const { token } = engine.programInstallPreview();
  await assert.rejects(engine.programInstall({ token }), /connection lost/);
  const record = engine.programs().tests[0];
  assert.equal(record.outcome, 'unknown');
  const written = record.slots.filter(s => s.messages.length);
  assert.equal(written[0].sent, written[0].messages.length);
  assert.equal(written[1].sent, 0);
  assert.equal(engine.programs().installBackups.length, 1);
});

test('renaming programs changes only their names, then syncs', async t => {
  const { engine, driver } = await fixture(t);
  const before = structuredClone(driver.programs.list);
  const sent = [];
  const write = driver.writePrograms.bind(driver);
  driver.writePrograms = messages => {
    sent.push(...messages);
    write(messages);
  };
  const result = await engine.programRename({ names: { 1: 'Big olives', 2: 'Trees x road' } });
  assert.equal(result.outcome, 'synced', JSON.stringify(result.problems));
  assert.deepEqual(sent, [
    { Category: 'Irrigation', Type: 'IrrPgmData', Oper: 'Upd', Seq: 1, Name: 'Big olives' },
    { Category: 'Irrigation', Type: 'IrrPgmData', Oper: 'Upd', Seq: 2, Name: 'Trees x road' },
  ]);
  const strip = list => list.map(({ name, ...p }) => p);
  assert.deepEqual(programDefinition(strip(driver.programs.list)), programDefinition(strip(before)));
  assert.deepEqual(
    driver.programs.list.slice(0, 3).map(p => p.name.trim()),
    ['Big olives', 'Trees x road', 'Pots'],
  );
  assert.equal((await engine.programRename({ names: { 1: 'Big olives' } })).outcome, 'nothing to change');
});

test('names that the controller can’t take are refused before contacting Tucor', async t => {
  const { engine, driver } = await fixture(t);
  let opened = 0;
  const sessions = driver.withSession.bind(driver);
  driver.withSession = fn => {
    opened++;
    return sessions(fn);
  };
  for (const [payload, message] of [
    [{}, /Expected names/],
    [{ names: {} }, /Expected names/],
    [{ names: { 11: 'Spare' } }, /no program 11/],
    [{ names: { 5: 'Citrus + pots' } }, /1–12 plain characters/],
    [{ names: { 5: ' Pots' } }, /1–12 plain characters/],
    [{ names: { 5: 'Pots ✓' } }, /1–12 plain characters/],
    [{ names: { 5: '' } }, /1–12 plain characters/],
  ])
    await assert.rejects(engine.programRename(payload), message);
  assert.equal(opened, 0);
});

test('a sync Tucor confirms but doesn’t follow with a readback is reported as such, not as unknown', async t => {
  const { engine, driver } = await fixture(t);
  const sessions = driver.withSession.bind(driver);
  driver.withSession = fn =>
    sessions(s => {
      let reads = 0;
      return fn({
        ...s,
        get codes() {
          return s.codes;
        },
        // The open, the readback after writing, then nothing after the sync.
        readPrograms: async () => {
          if (++reads > 1) throw new Error('No confirmation for program list; inspect controller before retrying');
          return s.readPrograms();
        },
      });
    });
  const result = await engine.programRename({ names: { 1: 'Big olives' } });
  assert.equal(result.outcome, 'synced, not read back');
  assert.equal(driver.synced, true);
  assert.match(engine.programs().tests[0].readbackError, /No confirmation/);
});

test('a rename Tucor has already synced by itself is reported as already synced', async t => {
  const { engine, driver } = await fixture(t);
  // As on 2026-10-29: after name changes Tucor proposed nothing and reported I01:01.
  const proposal = driver.syncProposal.bind(driver);
  driver.syncProposal = () => {
    driver.synced = true;
    return proposal();
  };
  const result = await engine.programRename({ names: { 1: 'Big olives' } });
  assert.equal(result.outcome, 'already synced');
  assert.equal(result.ok, true);
});
