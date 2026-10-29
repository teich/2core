import { dateKey } from '../lib/planner.mjs';
import { lettersFor } from '../lib/program-messages.mjs';

const NAMES = [
  'Primary bedroom deck pots',
  'Rear Lawn',
  'Rear lawn drip',
  'Timber steps',
  'Patio upper',
  'Patio lower',
  'Citrus and entry pots',
  'Rose arbor',
  'Front lawn pop-ups',
  'Front lawn terrace',
  'Orchard',
  'Vegetable garden',
];

// Shapes match Tucor's Programs packets (see test/fixtures/tucor-programs.json).
const PROGRAM_CAPABILITIES = {
  programMethod: ['Sequential'],
  name: { enable: true, maxLength: 12 },
  wb: { minimum: 0, maximum: 250 },
  startTimes: { maxStarts: 12 },
  steps: { maxStationsPerStep: 1 },
  programTypes: [
    { value: '0', label: 'WB' },
    { value: '4', label: 'Weather' },
  ],
  periods: [
    { value: 0, label: '14 days', editable: true },
    { value: 1, label: 'Odd', editable: false },
    { value: 2, label: 'Even', editable: false },
  ],
};
const program = (ID, name, status, waterBudget, period, fullDaySchedule, starttime, steps) => ({
  ID: String(ID),
  name: name.padEnd(12),
  booster: '0',
  status: String(status),
  waterBudget: String(waterBudget),
  irrigationType: '0',
  fullDaySchedule,
  runningStatus: 'Not running',
  runningEntries: [],
  period: String(period),
  starts: [{ startSeq: '1', starttime: String(starttime), cycles: '1', endtime: '-1' }],
  steps: steps.map(([zone, minutes]) => ({
    runSeq: String(zone),
    runtime: String(minutes * 60),
    decoders: [String(zone)],
  })),
});
const PROGRAMS = [
  // Like the production controller's slot 1: off, no days. The test write uses it.
  program(1, 'Lawns+perims', 0, 150, 0, '--------------', 330, [
    [2, 6],
    [5, 5],
    [9, 7],
  ]),
  program(2, 'Beds+drip', 1, 100, 2, '-M-W-F-S-t-T-s', 240, [
    [3, 20],
    [5, 15],
    [6, 15],
  ]),
  program(3, 'Pots', 1, 100, 0, '--t-T-s--t-T-s', 420, [
    [1, 5],
    [7, 6],
  ]),
  program(4, 'Trees', 1, 100, 0, '----T------T--', 180, [
    [11, 60],
    [12, 45],
  ]),
  program(5, 'Old roses', 0, 100, 0, '--------------', 360, [[8, 20]]),
];

export class DemoDriver {
  // delayMs imitates a slow controller so the UI's waiting states can be seen.
  constructor({ delayMs = 0 } = {}) {
    this.runs = [];
    this.rainUntil = 0;
    this.nextHandle = 1;
    this.delayMs = delayMs;
    this.programs = { capabilities: PROGRAM_CAPABILITIES, list: structuredClone(PROGRAMS), receivedAt: null };
    // Like Tucor, program edits wait in the cloud until a sync.
    this.synced = true;
    this.readPrograms();
  }
  state() {
    const now = Date.now();
    this.runs = this.runs.filter(r => r.endsAt > now);
    return {
      controller: { id: 2479, name: 'Garden simulator', type: 'LTD' },
      receivedAt: new Date(now).toISOString(),
      status: {
        controllerMode: '2',
        voltageV: 34.9,
        current: this.runs.length ? 85 : 19,
        currentFlow: this.runs.length ? 4 : 0,
        rainShutDown: Math.max(0, Math.ceil((this.rainUntil - now) / 1000)),
      },
      alarms: [],
      stations: NAMES.map((name, i) => ({
        StId: String(i + 1),
        name,
        label: `ST${i + 1}`,
        isRunning: this.runs.some(r => r.zone === String(i + 1)),
        runningEntries: this.runs
          .filter(r => r.zone === String(i + 1))
          .map(r => ({
            handleID: r.handle,
            runningMode: 'Manually Started',
            remainingSeconds: Math.max(0, Math.ceil((r.endsAt - now) / 1000)),
          })),
      })),
      programs: this.programs,
    };
  }
  /** Tucor lists the fortnight from the day of the read. */
  readPrograms() {
    const arranged = lettersFor(dateKey(new Date()));
    for (const p of this.programs.list) {
      p.allDaysArranged = arranged;
      // Tucor letters each watering day as allDaysArranged does.
      p.fullDaySchedule = [...p.fullDaySchedule].map((ch, i) => (ch === '-' ? '-' : arranged[i])).join('');
    }
    this.programs = { ...this.programs, receivedAt: new Date().toISOString() };
    return structuredClone(this.programs);
  }
  /** Applies the program editor's messages the way the controller is meant to. */
  writePrograms(messages) {
    if (messages.length) this.synced = false;
    const find = id => this.programs.list.find(p => Number(p.ID) === Number(id));
    const fields = {
      Status: 'status',
      IrrType: 'irrigationType',
      Period: 'period',
      Weekdays: 'fullDaySchedule',
      Budget: 'waterBudget',
      Booster: 'booster',
      Name: 'name',
    };
    for (const m of messages) {
      if (m.Type === 'IrrPgmData') {
        for (const [key, field] of Object.entries(fields)) if (key in m) find(m.Seq)[field] = String(m[key]);
      } else if (m.Type === 'IrrPgmStart') {
        const p = find(m.PgmId);
        p.starts = p.starts.filter(s => Number(s.startSeq) !== m.Seq);
        if (m.Time !== -1)
          p.starts.push({
            startSeq: String(m.Seq),
            starttime: String(m.Time),
            cycles: String(m.Cycles),
            endtime: String(m.EndTime),
          });
        p.starts.sort((a, b) => Number(a.startSeq) - Number(b.startSeq));
      } else if (m.Type === 'IrrPgmCont') {
        const p = find(m.PgmId);
        p.steps = p.steps.filter(s => Number(s.runSeq) !== m.Seq);
        if (m.RunTime) p.steps.push({ runSeq: String(m.Seq), runtime: String(m.RunTime), decoders: [String(m.Seq)] });
        p.steps.sort((a, b) => Number(a.runSeq) - Number(b.runSeq));
      }
    }
  }
  pause() {
    return new Promise(resolve => setTimeout(resolve, this.delayMs));
  }
  /** What Tucor's sync dialog proposes: programs from the app when they're waiting. */
  syncProposal() {
    const record = (sectionid, waiting) => ({
      sectionid,
      useappdata: waiting ? '1' : '0',
      usectrldata: '0',
      warning: '0',
    });
    return {
      capabilities: { sections: { 1: 'Stations', 2: 'Programs' } },
      records: [record('1', false), record('2', !this.synced)],
    };
  }
  async withSession(fn) {
    const driver = this;
    return fn({
      get codes() {
        return [driver.synced ? 'I01:01' : 'I01:02'];
      },
      snapshot: () => this.state(),
      start: async (zone, minutes) => {
        await this.pause();
        const handle = this.nextHandle++;
        this.runs.push({ zone, handle, endsAt: Date.now() + minutes * 60000 });
        return { handle };
      },
      stop: async handles => {
        await this.pause();
        this.runs = this.runs.filter(r => !handles.includes(r.handle));
      },
      rain: async hours => {
        this.rainUntil = hours ? Date.now() + hours * 3600000 : 0;
      },
      record: () => ({ stop: () => [] }),
      openPrograms: async () => this.readPrograms(),
      writePrograms: messages => this.writePrograms(messages),
      readPrograms: async () => {
        await this.pause();
        return this.readPrograms();
      },
      settle: () => this.pause(),
      startSync: async () => this.syncProposal(),
      executeSync: async () => {
        await this.pause();
        this.synced = true;
      },
      closePrograms: () => {},
      closeSync: () => {},
    });
  }
  async close() {}
}
