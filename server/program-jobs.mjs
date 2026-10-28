// Writes to the controller's programs. Each is one job the owner starts, in
// one Tucor session: open Tucor's Programs page, read the programs fresh, check
// them, send the program editor's messages, read them back, then run Tucor's
// sync, which program edits need before they reach the controller. Jobs are
// never retried; everything Tucor sends meanwhile is kept for review
// (research/protocol.md, “Writing” and “Sync”).
import { createHash } from 'node:crypto';
import { programDefinition, readCapabilities, readProgram } from '../lib/programs.mjs';
import {
  lettersFor,
  programMessages,
  readbackProblems,
  restoreTarget,
  syncCheck,
  weekdaysFor,
  writeSlot,
} from '../lib/program-messages.mjs';
import { dateKey } from '../lib/planner.mjs';
import { AppError } from './validation.mjs';

/** @typedef {import('../lib/program-messages.mjs').SlotTarget} SlotTarget */

/**
 * The supervised test write (research/scheduling-plan.md): one zone for one
 * minute on a slot that is off and stays off, so nothing can water.
 */
export const PROGRAM_TEST = Object.freeze({ slot: 1, zone: '2', seconds: 60, startMinute: 23 * 60, days: [1, 8] });
// How many backups of the programs from before an install are kept.
const BACKUPS = 5;
// Dashboard packets arrive every few seconds; a job keeps only what identifies them.
const NOISE = ['Main', 'Stations', 'Flow', 'ElectricFlow'];
const keep = ({ at, message: m }) => {
  if (NOISE.includes(m?.component)) return { at, component: m.component };
  if (m?.component === 'Programs' && Array.isArray(m.data))
    return { at, component: 'Programs', programs: m.data.length };
  const text = JSON.stringify(m);
  return { at, message: text.length > 4000 ? `${text.slice(0, 4000)}…` : m };
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bySlot = (list, slot) => list?.find(p => Number(p.ID) === Number(slot));

export class ProgramJobs {
  /** @param {import('./engine.mjs').Engine} engine */
  constructor(engine) {
    this.engine = engine;
  }
  get store() {
    return this.engine.store;
  }
  today() {
    return dateKey(new Date(this.engine.clock()));
  }

  /** POST /api/programs/test-write: the supervised test, on a slot that stays off. */
  test() {
    return this.job('test write', list => {
      const raw = bySlot(list, PROGRAM_TEST.slot),
        today = this.today();
      const days = Array.from({ length: 14 }, (_, d) => PROGRAM_TEST.days.includes(d));
      /** @type {SlotTarget} */
      const goal = {
        active: false,
        type: 0,
        period: 0,
        weekdays: weekdaysFor(days, today),
        budget: 100,
        booster: null,
        starts: [
          {
            minute: PROGRAM_TEST.startMinute,
            cycles: 1,
            endTime: PROGRAM_TEST.startMinute + PROGRAM_TEST.seconds / 60,
          },
        ],
        steps: [{ zone: PROGRAM_TEST.zone, seconds: PROGRAM_TEST.seconds }],
      };
      const targets = new Map([[PROGRAM_TEST.slot, goal]]);
      // Written earlier today and not yet synced: nothing to write, only the sync.
      if (!readbackProblems(raw, goal).length) return targets;
      const original = bySlot(this.store.get('programsOriginal')?.list, PROGRAM_TEST.slot);
      if (!original) throw new AppError('2core has no saved copy of this slot to restore from; nothing was sent');
      if (JSON.stringify(programDefinition([raw])) !== JSON.stringify(programDefinition([original])))
        throw new AppError(
          `Program ${PROGRAM_TEST.slot} changed since 2core first saw it; restore it first. Nothing was sent`,
        );
      if (readProgram(raw).active || /[^-]/.test(raw.fullDaySchedule))
        throw new AppError(`Program ${PROGRAM_TEST.slot} is on or has watering days; nothing was sent`);
      return targets;
    });
  }
  /** POST /api/programs/restore-test-slot: puts the test slot back from 2core's first copy. */
  restoreTest() {
    return this.job('restore test slot', list => {
      const raw = bySlot(list, PROGRAM_TEST.slot);
      const saved = this.store.get('programsOriginal');
      const original = bySlot(saved?.list, PROGRAM_TEST.slot);
      if (!original) throw new AppError('2core has no saved copy of this slot; nothing was sent');
      // The test leaves the slot off. Someone who turned it on since should decide.
      if (readProgram(raw).active && !readProgram(original).active)
        throw new AppError(`Program ${PROGRAM_TEST.slot} was turned on since the test; nothing was sent`);
      return new Map([[PROGRAM_TEST.slot, restoreTarget(original, dateKey(new Date(saved.receivedAt)), this.today())]]);
    });
  }

  /**
   * The saved plan as the controller's ten programs, for one list of programs
   * read today: the dry run, and a token for exactly these messages.
   * @param {any} [latest] A programs read; the last one 2core kept by default.
   */
  preview(latest = this.store.get('programs')) {
    const today = this.today();
    const result = programMessages({
      candidate: this.engine.plans.programPreview({}),
      current: latest?.list ?? [],
      capabilities: readCapabilities(latest?.capabilities),
      today,
      readDate: latest?.receivedAt ? dateKey(new Date(latest.receivedAt)) : undefined,
    });
    return { ...result, token: hash({ today, programs: result.programs.map(p => [p.slot, p.messages]) }) };
  }
  /**
   * POST /api/programs/install-preview: what installing the saved plan would
   * send, from 2core's last read of the programs. Doesn't contact Tucor.
   */
  installPreview() {
    return this.preview();
  }
  /**
   * POST /api/programs/install: installs a reviewed preview, if nothing changed since.
   * @param {{ token?: string }} [payload]
   */
  async install({ token } = {}) {
    if (typeof token !== 'string' || !token) throw new AppError('Review the install first; its token is missing', 400);
    // Checked against the last read first, so a stale review costs no Tucor contact.
    if (this.preview().token !== token)
      throw new AppError('The plan or the controller’s programs changed since the review; review again', 409);
    return await this.job(
      'install plan',
      (list, read) => {
        const fresh = this.preview(read);
        if (fresh.status !== 'ready')
          throw new AppError(`The plan can’t be installed: ${fresh.issues.map(i => i.message).join(' ')}`);
        if (fresh.token !== token)
          throw new AppError('The plan or the controller’s programs changed since the review; review again', 409);
        return new Map(fresh.programs.map(p => [p.slot, p.target]));
      },
      { backup: true },
    );
  }
  /**
   * POST /api/programs/restore-before-install: puts all programs back as they
   * were before an install, the newest backup unless \`backup\` names one.
   */
  /** @param {{ backup?: string | null }} [payload] */
  async restoreInstall({ backup = null } = {}) {
    const backups = this.store.get('programBackups', []);
    const saved = backup ? backups.find(b => b.receivedAt === backup) : backups[0];
    if (!saved)
      throw new AppError(backup ? 'No backup was made at that time' : 'No install has been made to undo', 404);
    return await this.job('restore before install', list => {
      const targets = new Map();
      for (const raw of saved.list) {
        if (!bySlot(list, raw.ID)) throw new AppError(`Tucor didn’t list program ${raw.ID}; nothing was sent`);
        targets.set(Number(raw.ID), restoreTarget(raw, dateKey(new Date(saved.receivedAt)), this.today()));
      }
      return targets;
    });
  }

  /**
   * One program job. \`plan\` sees the fresh read and returns each slot's target,
   * or throws to refuse before anything is sent.
   * @param {string} kind
   * @param {(list: any[], read: any) => Map<number, SlotTarget>} plan
   * @param {{ backup?: boolean }} [options] `backup` keeps the programs as read, before writing anything.
   */
  async job(kind, plan, { backup = false } = {}) {
    const engine = this.engine;
    engine.writable();
    if (!engine.allowProgramWrites)
      throw new AppError('Program writes are off; set ALLOW_PROGRAM_WRITES=true only for a supervised write', 403);
    const today = this.today();
    const record = /** @type {any} */ ({
      kind,
      startedAt: new Date(engine.clock()).toISOString(),
      outcome: 'not sent',
    });
    return engine.withCurrent(async session => {
      const recorder = session.record();
      try {
        const read = await session.openPrograms();
        engine.recordPrograms(read);
        const list = read.list ?? [];
        if (!list.length) throw new AppError('Tucor didn’t list the programs; nothing was sent');
        if (list.some(p => p.allDaysArranged !== lettersFor(today)))
          throw new AppError(`Tucor’s calendar doesn’t start today (${today}); nothing was sent`);
        // A program edited while it runs, or a zone running, could stop or double watering.
        if (list.some(p => p.runningEntries?.length || (p.runningStatus && p.runningStatus !== 'Not running')))
          throw new AppError('A program is running; nothing was sent. Try again when it’s finished');
        if (engine.current?.stations?.some(s => s.isRunning || s.runningEntries?.length))
          throw new AppError('A zone is running; nothing was sent. Try again when it’s finished');
        const targets = plan(list, read);
        const capabilities = readCapabilities(read.capabilities);
        const slots = [...targets].map(([slot, target]) => {
          const raw = bySlot(list, slot);
          if (!raw) throw new AppError(`Tucor didn’t list program ${slot}; nothing was sent`);
          return { slot, name: readProgram(raw).name, before: raw, target, ...writeSlot(raw, target, capabilities) };
        });
        const messages = slots.flatMap(s => s.messages);
        Object.assign(record, {
          slots: slots.map(({ before, ...s }) => ({ ...s, sent: 0 })),
          before: slots.map(s => s.before),
          changes: slots.flatMap(s => s.changes.map(c => `Program ${s.slot}: ${c}`)),
          messages,
        });
        const goals = new Map(slots.map(s => [s.slot, s.target]));
        // Tucor says whether its cloud and the controller differ.
        const unsynced = () => (session.codes ?? []).filter(c => /^I01(:|$)/.test(c)).at(-1) === 'I01:02';
        const ready = () => {
          if (engine.activeDeadline && engine.clock() > engine.activeDeadline)
            throw new AppError('Command expired before sending; nothing was sent', 400);
          // The write and its sync must finish inside this session, never across two.
          if (session.expiresAt && session.expiresAt - engine.clock() < 420000)
            throw new AppError('The Tucor session is too close to its time limit; nothing was sent. Try again later');
        };
        if (!messages.length) {
          record.outcome = 'nothing to change';
          if (!unsynced()) return { ok: true, outcome: record.outcome, changes: record.changes };
          ready();
          return await this.sync(session, record, goals);
        }
        ready();
        // Kept only when something will be written, so the newest backup is always
        // the programs as they were before the last install that changed them.
        if (backup)
          this.store.set(
            'programBackups',
            [
              { receivedAt: read.receivedAt, capabilities: read.capabilities, list },
              ...this.store.get('programBackups', []),
            ].slice(0, BACKUPS),
          );
        record.outcome = 'unknown';
        // Slot by slot, so a write that stops partway says how far it got.
        for (const [i, s] of slots.entries()) {
          if (!s.messages.length) continue;
          await session.writePrograms(s.messages, i === slots.findIndex(x => x.messages.length));
          record.slots[i].sent = s.messages.length;
        }
        await session.settle();
        const back = await session.readPrograms();
        engine.recordPrograms(back);
        await session.settle();
        const problems = this.problems(session.programs?.list ?? back.list, goals);
        Object.assign(record, {
          after: [...goals.keys()].map(slot => bySlot(session.programs?.list ?? back.list, slot)),
          problems,
          outcome: problems.length ? 'readback differs' : 'not synced',
        });
        if (problems.length) return { ok: false, outcome: record.outcome, changes: record.changes, problems };
        return await this.sync(session, record, goals);
      } catch (e) {
        record.error = e.message;
        throw e;
      } finally {
        record.trace = recorder.stop().map(keep);
        record.codes = session.codes ?? [];
        record.finishedAt = new Date(engine.clock()).toISOString();
        session.closePrograms();
        this.store.set('programTests', [record, ...this.store.get('programTests', [])].slice(0, 5));
      }
    });
  }
  /** Each slot's differences from its target, labelled by program. */
  problems(list, goals) {
    return [...goals].flatMap(([slot, goal]) =>
      readbackProblems(bySlot(list, slot), goal).map(p => `Program ${slot}: ${p}`),
    );
  }
  /**
   * Sends the cloud's programs to the controller with Tucor's sync. It runs
   * only when Tucor proposes app-to-controller for programs and nothing for any
   * other section, and never changes a direction.
   * @param {any} session @param {any} record @param {Map<number, SlotTarget>} goals
   */
  async sync(session, record, goals) {
    const changes = record.changes;
    try {
      const check = syncCheck(await session.startSync());
      record.sync = { sections: check.sections, problems: check.problems };
      if (!check.ok) {
        record.outcome = 'not synced';
        return { ok: false, outcome: record.outcome, changes, problems: check.problems };
      }
      record.outcome = 'sync unknown';
      await session.executeSync();
      record.sync.finishedAt = new Date(this.engine.clock()).toISOString();
      const back = await session.readPrograms();
      this.engine.recordPrograms(back);
      const problems = this.problems(back.list, goals);
      Object.assign(record, {
        after: [...goals.keys()].map(slot => bySlot(back.list, slot)),
        problems,
        outcome: problems.length ? 'synced, readback differs' : 'synced',
      });
      return { ok: !problems.length, outcome: record.outcome, changes, problems };
    } finally {
      session.closeSync();
    }
  }
}
