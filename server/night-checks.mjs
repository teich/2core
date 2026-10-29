// The nightly checks: whether the controller can run tonight, and whether a
// planned zone is seen running. Tucor reports nothing about past runs, so
// these two short, read-only sessions are all the evidence there is
// (research/scheduling-plan.md, “Step 5: noticing a missed night”).
import { createHash } from 'node:crypto';
import { programDefinition, readProgram } from '../lib/programs.mjs';
import { currentNight, dateKey, fromKey } from '../lib/planner.mjs';
import {
  SPOT_GRACE,
  controllerNight,
  eveningAt,
  eveningFindings,
  nightStatus,
  planNight,
  spotOutcome,
  spotTarget,
} from '../lib/night-checks.mjs';

// Nights kept, newest first.
const KEPT = 14;
// An evening check that fails is tried again this often, up to ATTEMPTS times.
const RETRY_MS = 10 * 60000;
const ATTEMPTS = 3;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const definition = list => JSON.stringify(programDefinition(list));

export class NightChecks {
  /** @param {import('./engine.mjs').Engine} engine @param {{ enabled?: boolean }} [options] */
  constructor(engine, { enabled = true } = {}) {
    this.engine = engine;
    this.enabled = enabled;
    this.busy = false;
    this.cache = null;
  }
  get store() {
    return this.engine.store;
  }
  nights() {
    return this.store.get('nights', []);
  }
  save(record) {
    this.store.set(
      'nights',
      [record, ...this.nights().filter(n => n.night !== record.night)]
        .sort((a, b) => (a.night < b.night ? 1 : -1))
        .slice(0, KEPT),
    );
  }
  /** Minutes since the midnight that starts `night`'s evening. */
  minute(night, now = this.engine.clock()) {
    return (now - fromKey(night).getTime()) / 60000;
  }
  /** The night's runs from the programs 2core last read. */
  expected(night) {
    const latest = this.store.get('programs');
    if (!latest?.list?.length) return [];
    return controllerNight(latest.list.map(readProgram), dateKey(new Date(latest.receivedAt)), night);
  }

  /** Called after a program job leaves the controller as 2core wrote it. */
  installed(kind) {
    const latest = this.store.get('programs');
    if (!latest?.list?.length) return;
    this.store.set('programsInstalled', {
      at: new Date(this.engine.clock()).toISOString(),
      kind,
      definition: definition(latest.list),
      plan: hash(this.engine.plans.plan()),
    });
    this.cache = null;
  }
  /**
   * Whether the controller still holds what 2core installed, and whether the
   * plan has changed since. `{ state, message }`, `state` one of matches,
   * plan changed, controller changed, unknown.
   */
  sync() {
    const latest = this.store.get('programs'),
      baseline = this.store.get('programsInstalled'),
      plan = hash(this.engine.plans.plan()),
      today = dateKey(new Date(this.engine.clock()));
    const key = JSON.stringify([latest?.receivedAt, baseline?.at, plan, today]);
    if (this.cache?.key === key) return this.cache.value;
    const value = this.compare(latest, baseline, plan, today);
    this.cache = { key, value };
    return value;
  }
  compare(latest, baseline, plan, today) {
    if (!latest?.list?.length) return { state: 'unknown', message: '2core hasn’t read the controller’s programs yet' };
    const readToday = dateKey(new Date(latest.receivedAt)) === today;
    // The install review compares with what the controller has, and only works on a read from today.
    const preview = readToday ? this.engine.programJobs.preview(latest) : null;
    const holdsPlan = preview?.status === 'ready' && !preview.programs.some(p => p.messages.length);
    const adopt = () => {
      this.store.set('programsInstalled', {
        at: new Date(this.engine.clock()).toISOString(),
        kind: 'matched the plan',
        definition: definition(latest.list),
        plan,
      });
      return { state: 'matches', message: 'The controller holds the saved plan' };
    };
    if (!baseline)
      return holdsPlan
        ? adopt()
        : { state: 'unknown', message: '2core hasn’t seen the controller hold the plan yet; review the install' };
    if (definition(latest.list) !== baseline.definition)
      return {
        state: 'controller changed',
        message: `The controller’s programs changed outside 2core since ${new Date(baseline.at).toLocaleDateString()}`,
      };
    if (baseline.plan !== plan)
      return holdsPlan
        ? adopt()
        : { state: 'plan changed', message: 'The plan changed since the last install; review and install it' };
    return { state: 'matches', message: 'The controller holds the saved plan' };
  }

  /** Runs whichever check is due. Called every minute. */
  async tick() {
    if (!this.enabled || this.busy) return;
    this.busy = true;
    try {
      const now = this.engine.clock(),
        night = dateKey(currentNight(new Date(now)));
      for (const old of this.nights().filter(n => n.night < night && !n.closed)) this.save({ ...old, closed: true });
      const record = this.nights().find(n => n.night === night) ?? { night, runs: this.expected(night) };
      if (!record.evening?.ok) record.runs = this.expected(night);
      const minute = this.minute(night, now);
      const first = record.runs.length ? record.runs[0].from : 1440;
      const attempts = record.evening?.attempts ?? 0;
      const retry = !record.evening || now - Date.parse(record.evening.at) >= RETRY_MS;
      if (!record.evening?.ok && attempts < ATTEMPTS && retry && minute >= eveningAt(record.runs) && minute < first) {
        await this.evening(record, attempts + 1);
        return;
      }
      const target = record.target;
      if (target && !record.spot && minute >= target.at) {
        if (minute <= target.at + SPOT_GRACE) await this.spot(record);
        else {
          record.spot = {
            at: new Date(now).toISOString(),
            outcome: 'not checked',
            warn: false,
            message: '2core wasn’t running at the planned time',
          };
          this.save(record);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** The evening session: a fresh read of status and programs, and what it means for tonight. */
  async evening(record, attempts) {
    const engine = this.engine;
    let codes = [];
    try {
      await engine.serial(
        () =>
          engine.withCurrent(
            async session => {
              const read = await session.openPrograms();
              try {
                engine.recordPrograms(read);
              } finally {
                codes = [...(session.codes ?? [])];
                session.closePrograms();
              }
            },
            { user: false },
          ),
        1,
      );
    } catch (e) {
      record.evening = { at: new Date(engine.clock()).toISOString(), ok: false, attempts, error: e.message };
      this.save(record);
      if (attempts >= ATTEMPTS)
        this.store.event('night check', { night: record.night, outcome: 'failed', message: e.message });
      return;
    }
    const now = engine.clock();
    record.runs = this.expected(record.night);
    let candidate = null;
    try {
      candidate = engine.plans.programPreview({});
    } catch {
      // A plan that doesn't compile only skips the comparison with tonight's plan.
    }
    const status = engine.current?.status ?? {};
    const first = record.runs[0]?.from;
    const findings = eveningFindings({
      status,
      alarms: engine.current?.alarms ?? [],
      codes,
      runs: record.runs,
      planRuns: planNight(candidate, record.night),
      sync: this.sync(),
      firstStartInSeconds: first == null ? null : Math.max(0, (first - this.minute(record.night, now)) * 60),
      rainSource: this.store.get('rain')?.source ?? null,
    });
    record.evening = { at: new Date(now).toISOString(), ok: true, attempts, findings, codes };
    // Looking for a run is only worth a session when the night should run, and
    // only at a zone the rain delay doesn't skip.
    const rain = findings.find(f => f.code === 'rain');
    const runs = rain?.skipped ? record.runs.filter(r => !rain.skipped.includes(r.zone)) : record.runs;
    record.target = rain?.held || findings.some(f => f.warn) ? null : spotTarget(runs);
    this.save(record);
    const warnings = findings.filter(f => f.warn);
    if (warnings.length)
      this.store.event('night check', {
        night: record.night,
        outcome: 'warning',
        message: warnings.map(f => f.message).join('; '),
      });
  }

  /** The spot check: is a planned zone running? */
  async spot(record) {
    const engine = this.engine;
    try {
      await engine.serial(() => engine.withCurrent(async () => {}, { user: false }), 1);
    } catch (e) {
      record.spot = {
        at: new Date(engine.clock()).toISOString(),
        outcome: 'not checked',
        warn: false,
        message: e.message,
      };
      this.save(record);
      return;
    }
    const running = (engine.current?.stations ?? [])
      .filter(s => s.isRunning || s.runningEntries?.length)
      .map(s => String(s.StId));
    const seen = spotOutcome(record.target, running, engine.current?.status ?? {});
    record.spot = { at: new Date(engine.clock()).toISOString(), ...seen, running };
    this.save(record);
    if (seen.warn) this.store.event('night check', { night: record.night, outcome: 'warning', message: seen.message });
  }

  /** For GET /api/state: recent nights, each with one status, and the sync state. */
  summary() {
    const now = this.engine.clock(),
      night = dateKey(currentNight(new Date(now)));
    const stored = this.nights();
    const tonight = stored.find(n => n.night === night) ?? { night, runs: this.expected(night) };
    const nights = [tonight, ...stored.filter(n => n.night !== night)].map(n => {
      const runs = n.runs ?? [];
      return {
        night: n.night,
        ...nightStatus(n),
        zones: [...new Set(runs.map(r => r.zone))].length,
        start: runs.length ? Math.min(...runs.map(r => r.from)) : null,
        finish: runs.length ? Math.max(...runs.map(r => r.to)) : null,
        eveningAt: n.night === night && !n.evening ? eveningAt(runs) : null,
        evening: n.evening ?? null,
        target: n.target ?? null,
        spot: n.spot ?? null,
      };
    });
    return { enabled: this.enabled, sync: this.sync(), nights };
  }
}
