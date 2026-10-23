import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compilePrograms } from '../lib/program-compiler.mjs';
import { assignSlots, programMessages } from '../lib/program-messages.mjs';
import { readCapabilities, readProgram } from '../lib/programs.mjs';

const tucor = JSON.parse(readFileSync(new URL('./fixtures/tucor-programs.json', import.meta.url), 'utf8'));
const intents = JSON.parse(readFileSync(new URL('./fixtures/program-intents.json', import.meta.url), 'utf8'));
const capabilities = readCapabilities(tucor.capabilities.Capabilities);
// The captured packets list the fortnight from a Sunday, so they were read on one.
const sunday = '2026-10-11';

const raw = (id, extra = {}) => ({
  ID: String(id),
  name: `Prog ${id}`,
  status: '0',
  waterBudget: '100',
  irrigationType: '0',
  period: '0',
  allDaysArranged: 'SMtWTFsSMtWTFs',
  fullDaySchedule: '--------------',
  starts: [{ startSeq: '1', starttime: '-1', cycles: '1', endtime: '-1' }],
  steps: [],
  ...extra,
});
const mask = days => Array.from({ length: 14 }, (_, d) => days.includes(d));
const candidate = (programs, anchor = sunday) => ({
  status: 'candidate',
  calendarAnchor: anchor,
  programs: programs.map((p, i) => ({
    slot: i + 1,
    calendarMask: mask([0, 7]),
    clockMinute: 1320,
    steps: [{ zone: '3', name: 'Rear lawn drip', seconds: 600 }],
    ...p,
  })),
});
const write = (programs, current, extra = {}) =>
  programMessages({ candidate: candidate(programs), current, capabilities, today: sunday, ...extra });

test('the compiled fixture becomes programs, each switched off while edited and on last', () => {
  const compiled = compilePrograms({
    zones: intents.zones,
    ...intents.plan,
    start: new Date(2026, 9, 6),
    sunriseAt: () => 431,
  });
  const result = programMessages({ candidate: compiled, current: tucor.programs.data, capabilities, today: sunday });
  assert.equal(result.status, 'ready', JSON.stringify(result.issues));
  assert.equal(result.summary.programs, compiled.programs.length);
  const shift = 5; // 2026-10-06 to 2026-10-11
  // Every compiled program lands in exactly one slot.
  assert.deepEqual(
    result.programs
      .filter(p => p.use !== 'off')
      .map(p => p.compiled)
      .sort((a, b) => a - b),
    compiled.programs.map(p => p.slot),
  );
  for (const p of result.programs.filter(p => p.use === 'plan')) {
    const source = compiled.programs.find(c => c.slot === p.compiled);
    const was = tucor.programs.data.find(r => Number(r.ID) === p.slot);
    assert.deepEqual(p.messages.at(-1), {
      Category: 'Irrigation',
      Type: 'IrrPgmData',
      Oper: 'Upd',
      Seq: p.slot,
      Status: 1,
    });
    if (was.status === '1') assert.equal(p.messages[0].Status, 0);
    const weekdays = p.messages.find(m => m.Weekdays).Weekdays;
    assert.deepEqual(
      [...weekdays].map(ch => ch !== '-'),
      Array.from({ length: 14 }, (_, d) => source.calendarMask[(shift + d) % 14]),
    );
    const starts = p.messages.filter(m => m.Type === 'IrrPgmStart');
    assert.equal(starts.length, capabilities.maxStarts);
    assert.equal(starts[0].Time, source.clockMinute);
    assert.ok(starts.slice(1).every(s => s.Time === -1 && s.Cycles === null));
  }
  assert.equal(result.summary.messages, result.programs.reduce((n, p) => n + p.messages.length, 0) + 2);
});

test('steps are addressed by station, unchanged ones are skipped, and removals zero the runtime', () => {
  const current = [
    raw(1, {
      status: '1',
      steps: [
        { runSeq: '3', runtime: '600', decoders: ['3'] },
        { runSeq: '9', runtime: '300', decoders: ['9'] },
      ],
    }),
  ];
  const steps = [
    { zone: '3', name: 'Rear lawn drip', seconds: 600 },
    { zone: '5', name: 'Patio upper', seconds: 1740 },
  ];
  const result = write([{ steps }], current);
  const cont = result.programs[0].messages.filter(m => m.Type === 'IrrPgmCont');
  assert.deepEqual(cont, [
    { Category: 'Irrigation', Type: 'IrrPgmCont', Oper: 'Upd', PgmId: 1, Seq: 5, RunTime: 1740 },
    { Category: 'Irrigation', Type: 'IrrPgmCont', Oper: 'Upd', PgmId: 1, Seq: 9, RunTime: 0 },
  ]);
  assert.ok(result.programs[0].changes.includes('Add zone 5 · 29 min'));
  assert.ok(result.programs[0].changes.includes('Remove zone 9'));
  assert.ok(result.warnings.some(w => w.code === 'zeroed-steps'));
  const deletable = write([{ steps }], current, { capabilities: { ...capabilities, deleteStep: true } });
  assert.equal(deletable.programs[0].messages.find(m => m.Seq === 9 && m.Type === 'IrrPgmCont').Oper, 'Del');
});

test('settings are only rewritten when they differ, and spare slots are switched off', () => {
  const current = [
    raw(1, { status: '1', waterBudget: '145', period: '1', irrigationType: '4' }),
    raw(2, { status: '1' }),
    raw(3),
  ];
  const result = write([{}], current);
  const first = result.programs[0];
  assert.deepEqual(
    first.messages.filter(m => m.Type === 'IrrPgmData').map(m => Object.keys(m).at(-1)),
    ['Status', 'IrrType', 'Period', 'Weekdays', 'Budget', 'Status'],
  );
  assert.equal(first.messages.find(m => m.Weekdays).Weekdays, 'S------S------');
  assert.deepEqual(result.programs[1].messages, [
    { Category: 'Irrigation', Type: 'IrrPgmData', Oper: 'Upd', Seq: 2, Status: 0 },
  ]);
  assert.deepEqual(result.programs[2].messages, []);
  assert.equal(result.summary.slotsOff, 1);
  const plain = write([{}], [raw(1)]);
  assert.deepEqual(
    plain.programs[0].messages.filter(m => m.Type === 'IrrPgmData').map(m => Object.keys(m).at(-1)),
    ['Weekdays', 'Status'],
  );
});

test('the calendar is rotated from the compiler’s anchor to the day of the write', () => {
  const tuesday = raw(1, { allDaysArranged: 'tWTFsSMtWTFsSM' });
  const result = programMessages({
    candidate: candidate([{ calendarMask: mask([0, 9]) }], '2026-10-11'),
    current: [tuesday],
    capabilities,
    today: '2026-10-13',
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.programs[0].messages.find(m => m.Weekdays).Weekdays, '-------t----S-');
});

test('anything the messages can’t express blocks the whole write', () => {
  const blocked = (result, code) => {
    assert.equal(result.status, 'blocked');
    assert.ok(
      result.issues.some(i => i.code === code),
      JSON.stringify(result.issues),
    );
    assert.deepEqual(result.programs, []);
  };
  blocked(write([{}, {}], [raw(1)]), 'slots');
  blocked(write([{}], [raw(1)], { today: '2026-10-12' }), 'calendar-alignment');
  blocked(write([{}], [raw(1)], { capabilities: { ...capabilities, maxStationsPerStep: 2 } }), 'multi-station-steps');
  blocked(write([{}], [raw(1)], { capabilities: { ...capabilities, budget: { minimum: 0, maximum: 90 } } }), 'budget');
  blocked(write([{}], [raw(1)], { capabilities: null }), 'capabilities');
  blocked(write([{ clockMinute: 1320.5 }], [raw(1)]), 'start-time');
  blocked(write([{ steps: [{ zone: '3', name: 'Drip', seconds: 0 }] }], [raw(1)]), 'runtime');
  blocked(
    programMessages({ candidate: { status: 'blocked' }, current: [raw(1)], capabilities, today: sunday }),
    'no-candidate',
  );
});

test('programs go to the slots that already hold most of their zones', () => {
  const holding = (id, zones, extra = {}) =>
    raw(id, { steps: zones.map(z => ({ runSeq: z, runtime: '600', decoders: [z] })), ...extra });
  const current = [holding(1, ['8']), holding(2, ['3', '4']), holding(3, ['5', '6', '7'])];
  const step = zone => ({ zone, name: `Zone ${zone}`, seconds: 600 });
  const result = write([{ steps: [step('5'), step('6')] }, { steps: [step('3'), step('9')] }], current);
  assert.deepEqual(
    result.programs.map(p => [p.slot, p.compiled ?? null, p.use]),
    [
      [1, null, 'off'],
      [2, 2, 'plan'],
      [3, 1, 'plan'],
    ],
  );
  assert.deepEqual(
    result.programs[2].messages.filter(m => m.Type === 'IrrPgmCont').map(m => [m.Seq, m.RunTime]),
    [[7, 0]],
  );
  assert.deepEqual(assignSlots([{ steps: [] }, { steps: [] }], current.map(readProgram)), [0, 1]);
  // Slot 2 keeps only zone 3 of its new two, which still counts as half.
  assert.ok(!result.warnings.some(w => w.code === 'names'));
  const moved = write([{ steps: [step('3'), step('9'), step('10')] }], [holding(1, ['3', '4'])]);
  assert.match(moved.warnings.find(w => w.code === 'names').message, /Prog 1/);
});

test('a slot that already matches the plan sends nothing', () => {
  const matching = raw(1, {
    status: '1',
    fullDaySchedule: 'S------S------',
    starts: [{ startSeq: '1', starttime: '1320', cycles: '1', endtime: '1330' }],
    steps: [{ runSeq: '3', runtime: '600', decoders: ['3'] }],
  });
  const result = write([{}], [matching]);
  assert.equal(result.programs[0].use, 'keep');
  assert.deepEqual(result.programs[0].messages, []);
  assert.deepEqual(result.summary, { programs: 1, unchanged: 1, slotsOff: 0, messages: 2 });
  // A read from another day can't be compared with today's calendar.
  assert.ok(write([{}], [matching], { readDate: '2026-10-04' }).issues.some(i => i.code === 'calendar-alignment'));
});
