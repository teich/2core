// The bridge's controller core. One Engine owns the only Tucor client: it
// serializes every command and read through one queue, keeps the latest
// observation, records which runs 2core started, and answers GET /api/state.
//
// Plan editing (plan-service.mjs), the weather policy (weather-policy.mjs) and
// zone preferences (preferences.mjs) live in their own modules; Engine keeps
// one-line delegates for them so HTTP routes and tests have a single object.
import { createHash } from 'node:crypto';
import { trace } from './telemetry.mjs';
import { PlanService } from './plan-service.mjs';
import { WeatherPolicy } from './weather-policy.mjs';
import { mergePreferences } from './preferences.mjs';
import { programDefinition, readCapabilities, readProgram } from '../lib/programs.mjs';
import {
  lettersFor,
  readbackProblems,
  restoreTarget,
  syncCheck,
  weekdaysFor,
  writeSlot,
} from '../lib/program-messages.mjs';
import { dateKey } from '../lib/planner.mjs';
import { AppError, LIMITS, number } from './validation.mjs';

export { AppError, LIMITS, number };

/**
 * The supervised test write (research/scheduling-plan.md): one zone for one
 * minute on a slot that is off and stays off, so nothing can water.
 */
export const PROGRAM_TEST = Object.freeze({ slot: 1, zone: '2', seconds: 60, startMinute: 23 * 60, days: [1, 8] });
// Dashboard packets arrive every few seconds; a program test keeps only what identifies them.
const NOISE = ['Main', 'Stations', 'Flow', 'ElectricFlow'];
const keep = ({ at, message: m }) => {
  if (NOISE.includes(m?.component)) return { at, component: m.component };
  if (m?.component === 'Programs' && Array.isArray(m.data))
    return { at, component: 'Programs', programs: m.data.length };
  const text = JSON.stringify(m);
  return { at, message: text.length > 4000 ? `${text.slice(0, 4000)}…` : m };
};

/** Stations the controller reports as watering. */
const active = state => state.stations.filter(s => s.isRunning || s.runningEntries?.length);

export class Engine {
  constructor({
    driver,
    store,
    mode = 'demo',
    allowControl = false,
    allowProgramWrites = false,
    clock = Date.now,
    logger = () => {},
  }) {
    this.driver = driver;
    this.store = store;
    this.mode = mode;
    this.clock = clock;
    this.logger = logger;
    /** Set by server/index.mjs when a weather station is configured. */
    this.weatherSource = null;
    this.allowControl = mode === 'demo' || allowControl;
    this.allowProgramWrites = mode === 'demo' || (this.allowControl && allowProgramWrites);
    this.queue = Promise.resolve();
    this.jobs = [];
    this.inflight = new Map();
    this.store.interruptPending();
    this.current = this.store.get('lastObservation');
    this.plans = new PlanService(this);
    this.weatherPolicy = new WeatherPolicy(this);
    this.plans.seed();
    this.error = null;
    // An open session streams controller updates; take them instead of asking again.
    this.driver.onSnapshot = snapshot => this.accept(snapshot);
  }
  serial(fn, priority = 0) {
    const next = new Promise((resolve, reject) => this.jobs.push({ fn, priority, resolve, reject }));
    if (!this.draining) {
      this.draining = true;
      this.queue = Promise.resolve().then(async () => {
        while (this.jobs.length) {
          const index = this.jobs.findIndex(job => job.priority === 0);
          const [job] = this.jobs.splice(index < 0 ? 0 : index, 1);
          try {
            job.resolve(await job.fn());
          } catch (e) {
            job.reject(e);
          }
        }
        this.draining = false;
      });
    }
    return next;
  }
  accept(observation) {
    const { programs, ...state } = observation;
    if (programs?.list) this.recordPrograms(programs);
    this.current = state;
    this.error = null;
    this.observationVersion = (this.observationVersion ?? 0) + 1;
    this.store.set('lastObservation', state);
    const runs = this.store.get('runs', []);
    const handles = state.stations.flatMap(s => (s.runningEntries ?? []).map(e => `${s.StId}:${e.handleID}`));
    this.store.set(
      'runs',
      runs.filter(r => handles.includes(`${r.zone}:${r.handle}`)),
    );
    // A delay cleared at the controller or in Tucor's app must not keep answering knownHold().
    const rain = this.store.get('rain'),
      remaining = Number(state.status?.rainShutDown);
    if (
      rain &&
      state.status?.rainShutDown != null &&
      Number.isFinite(remaining) &&
      remaining === 0 &&
      Date.parse(rain.until) - Date.parse(state.receivedAt ?? new Date(this.clock()).toISOString()) > 120000
    )
      this.store.set('rain', null);
  }
  /**
   * Keeps the controller's programs as Tucor reported them. The first copy is
   * never replaced: it is the schedule to restore if 2core's programs go wrong.
   */
  recordPrograms({ capabilities, list, receivedAt }) {
    const latest = this.store.get('programs');
    if (latest?.receivedAt === receivedAt) return;
    const entry = { receivedAt, capabilities: capabilities ?? latest?.capabilities ?? null, list };
    this.store.transaction(() => {
      if (!this.store.get('programsOriginal')) this.store.set('programsOriginal', entry);
      else if (latest && JSON.stringify(programDefinition(latest.list)) !== JSON.stringify(programDefinition(list)))
        this.store.event('controller programs', {
          outcome: 'changed',
          message: 'The controller’s programs differ from the last copy 2core saw',
        });
      this.store.set('programs', entry);
    });
  }
  /** GET /api/programs: the controller's programs, read-only, with both raw backups. */
  programs() {
    const latest = this.store.get('programs'),
      original = this.store.get('programsOriginal');
    return {
      observedAt: latest?.receivedAt ?? null,
      capabilities: readCapabilities(latest?.capabilities),
      programs: (latest?.list ?? []).map(readProgram),
      backups: { latest, original },
      writesEnabled: this.allowProgramWrites,
      tests: this.store.get('programTests', []),
    };
  }
  refresh({ interactive = false, forceFresh = true } = {}) {
    if (this.refreshing) {
      // A foreground prepare arriving during a background read keeps that session warm.
      this.refreshInteractive ||= interactive;
      return this.refreshing;
    }
    this.refreshInteractive = interactive;
    const version = this.observationVersion;
    const t = trace(this.logger);
    const queued = performance.now();
    this.refreshing = this.serial(async () => {
      t.record('refresh_queue', queued);
      // A command ahead of this pending refresh already supplied a newer observation.
      if (version !== this.observationVersion && !this.refreshInteractive) return this.state();
      try {
        await this.driver.withSession(
          async s => {
            this.accept(s.snapshot());
            if (this.refreshInteractive) s.keepUntil = this.clock() + (this.driver.idleMs ?? 90000);
          },
          { interactive: this.refreshInteractive, forceFresh, telemetry: t },
        );
      } catch (e) {
        this.error = e.message;
        throw e;
      }
      return this.state();
    }, 1).finally(() => {
      this.refreshing = null;
      this.refreshInteractive = false;
    });
    return this.refreshing;
  }
  prepare() {
    // Fire-and-observe: opening the app must never wait for Tucor.
    this.refresh({ interactive: true, forceFresh: false }).catch(() => {});
    return { ok: true };
  }
  state() {
    const state = this.current;
    const age = state?.receivedAt ? this.clock() - Date.parse(state.receivedAt) : Infinity;
    const zones = (state?.stations ?? [])
      .map(s => {
        const pref = this.store.get(`zone:${s.StId}`, {});
        const run = this.store.get('runs', []).find(r => r.zone === String(s.StId));
        return {
          id: String(s.StId),
          name: pref.name || s.name || s.label || `Zone ${s.StId}`,
          configured: Boolean(s.name),
          favorite: pref.favorite || false,
          order: pref.order ?? Number(s.StId),
          running: s.isRunning === null ? null : Boolean(s.isRunning || s.runningEntries?.length),
          owned: Boolean(run),
          startedAt: run?.startedAt ?? null,
          minutes: run?.minutes ?? null,
          endsAt: run?.endsAt ?? null,
          notes: pref.notes ?? '',
          issues: pref.issues ?? [],
        };
      })
      .sort((a, b) => a.order - b.order || Number(a.id) - Number(b.id));
    return {
      operations: this.store.operations(),
      apiVersion: 1,
      mode: this.mode,
      controlEnabled: this.allowControl,
      limits: LIMITS,
      controller: state?.controller ?? null,
      available: Boolean(state && age < 180000 && !this.error),
      observedAt: state?.receivedAt ?? null,
      error: this.error,
      connection: {
        ...(this.driver.connection?.() ?? { open: this.mode === 'demo' }),
        checking: Boolean(this.refreshing),
      },
      weatherSource: this.weatherSource?.describe() ?? { configured: false },
      weatherReading: this.store.get('weatherReading'),
      status: state?.status ?? {},
      alarms: state?.alarms ?? [],
      zones,
      rain: this.store.get('rain'),
      policy: this.weatherPolicy.policy(),
      weatherDecision: this.store.get('weatherDecision'),
      events: this.store.events(),
      plan: this.plans.plan(),
      location: this.store.get('location'),
    };
  }
  submit(key, kind, body, fn, deadline) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key ?? '')) throw new AppError('A unique Idempotency-Key is required', 400);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          kind,
          Object.keys(body)
            .sort()
            .map(k => [k, body[k]]),
        ]),
      )
      .digest('hex');
    const old = this.store.command(key);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new AppError('Idempotency key was used for another command');
      const completion =
        this.inflight.get(key) ??
        (old.state === 'succeeded'
          ? Promise.resolve(JSON.parse(old.result))
          : Promise.reject(
              new AppError('Previous command failed or has an unknown outcome; refresh status before a new request'),
            ));
      completion.catch(() => {});
      return { operation: this.store.operation(key), completion };
    }
    const expires = Date.parse(deadline);
    if (!Number.isFinite(expires) || expires < this.clock() || expires > this.clock() + 120000)
      throw new AppError('Command expired or has an invalid deadline', 400);
    if (this.inflight.size >= 32) throw new AppError('Too many pending commands; wait for confirmation', 429);
    // Persist acceptance BEFORE acknowledging HTTP; execution belongs to the server.
    this.store.acceptCommand(key, fingerprint, kind, body, deadline, new Date(this.clock()).toISOString());
    const queued = performance.now();
    const t = trace(this.logger, key, stage => {
      const phase = stage === 'sending' ? 'sending' : stage.endsWith('_confirmation') ? 'confirming' : 'connecting';
      this.store.phase(key, phase);
    });
    const completion = this.serial(async () => {
      t.record('command_queue', queued);
      this.activeDeadline = expires;
      this.activeTrace = t;
      const started = performance.now();
      try {
        if (this.clock() > expires) throw new AppError('Command expired while queued; nothing was sent', 400);
        this.store.phase(key, 'connecting');
        const result = await fn();
        this.store.finish(key, 'succeeded', result);
        this.store.phase(key, 'succeeded');
        this.store.event(kind, { ...body, outcome: 'confirmed' });
        t.record('command_total', started);
        return result;
      } catch (e) {
        this.error = e instanceof AppError ? this.error : e.message;
        this.store.finish(key, 'failed', { error: e.message });
        this.store.phase(key, 'failed');
        this.store.event(kind, { ...body, outcome: 'failed', message: e.message });
        t.record('command_total', started, 'error');
        throw e;
      } finally {
        this.activeDeadline = null;
        this.activeTrace = null;
        this.inflight.delete(key);
      }
    });
    this.inflight.set(key, completion);
    completion.catch(() => {});
    return { operation: this.store.operation(key), completion };
  }
  async command(key, kind, body, fn, deadline) {
    return this.submit(key, kind, body, fn, deadline).completion;
  }
  writable() {
    if (!this.allowControl)
      throw new AppError('Live controls are disabled; enable only for supervised validation', 403);
  }
  async withCurrent(fn, { user = true } = {}) {
    return this.driver.withSession(
      async session => {
        this.accept(session.snapshot());
        if (this.activeDeadline && this.clock() > this.activeDeadline)
          throw new AppError('Command expired while connecting; nothing was sent', 400);
        const result = await fn(session);
        this.accept(session.snapshot());
        return result ?? { ok: true };
      },
      { interactive: user, user, telemetry: this.activeTrace ?? trace(this.logger), deadline: this.activeDeadline },
    );
  }
  async start(zone, minutes) {
    this.writable();
    number(minutes, LIMITS.minMinutes, LIMITS.maxMinutes, true);
    return this.withCurrent(async session => {
      if (!this.current.stations.some(s => String(s.StId) === zone)) throw new AppError('Unknown zone', 404);
      if (this.current.stations.some(s => s.isRunning === null || s.runningEntries === null))
        throw new AppError('Station activity is unknown; refresh before starting');
      if (active(this.current).length)
        throw new AppError('Another zone is running. Stop your current test before starting the next');
      if (this.current.status.rainShutDown == null || !Number.isFinite(Number(this.current.status.rainShutDown)))
        throw new AppError('Rain delay status is unknown; refresh before starting');
      if (Number(this.current.status.rainShutDown) > 0)
        throw new AppError('Rain delay is active. Manual operation during rain delay is not yet validated');
      if (Number(this.current.status.controllerMode) !== 2)
        throw new AppError('Controller must already be in Automatic mode');
      const started = await session.start(zone, minutes);
      const now = this.clock();
      const run = {
        zone,
        handle: started.handle,
        minutes,
        startedAt: new Date(now).toISOString(),
        endsAt: new Date(now + minutes * 60000).toISOString(),
      };
      this.store.set('runs', [run]);
      return { ok: true, run };
    });
  }
  async stop(zone = null) {
    this.writable();
    return this.withCurrent(async session => {
      const runs = this.store.get('runs', []).filter(r => zone === null || r.zone === zone);
      if (!runs.length && zone && active(this.current).some(s => String(s.StId) === zone))
        throw new AppError('This run was started outside 2core; stop it with the controller');
      if (runs.length) await session.stop(runs.map(r => r.handle));
      this.store.set(
        'runs',
        this.store.get('runs', []).filter(r => !runs.some(stop => stop.handle === r.handle)),
      );
      return { ok: true };
    });
  }
  async next(zone, minutes) {
    this.writable();
    number(minutes, LIMITS.minMinutes, LIMITS.maxMinutes, true);
    // Check the target before stopping anything. Both steps run under one command.
    await this.withCurrent(async () => {
      if (!this.current.stations.some(s => String(s.StId) === zone)) throw new AppError('Unknown zone', 404);
      const owned = this.store.get('runs', []);
      if (active(this.current).some(s => !owned.some(r => r.zone === String(s.StId))))
        throw new AppError('A zone was started outside 2core; stop it with the controller');
    });
    await this.stop();
    // start performs all safety checks again after the confirmed stop.
    return this.start(zone, minutes);
  }
  async rain(hours, source = 'manual', reason = 'Manual rain delay', trigger = null) {
    this.writable();
    number(hours, 0, 999, true);
    return this.withCurrent(
      async session => {
        if (Number(this.current.status.controllerMode) !== 2) throw new AppError('Rain delay requires Automatic mode');
        const remaining = Number(this.current.status.rainShutDown);
        if (this.current.status.rainShutDown == null || !Number.isFinite(remaining))
          throw new AppError('Rain delay status is unknown; refresh before changing it');
        const previous = this.store.get('rain');
        if (source === 'weather' && remaining > 0) {
          const expected = previous ? (Date.parse(previous.until) - this.clock()) / 1000 : 0;
          if (previous?.source !== 'weather' || Math.abs(remaining - expected) > 120)
            return { ok: true, preserved: true, reason: 'Existing manual or external rain delay preserved' };
          if (remaining >= hours * 3600 - 3600)
            return { ok: true, preserved: true, reason: 'Weather delay already covers this period' };
        }
        await session.rain(hours);
        this.store.set(
          'rain',
          hours
            ? {
                source,
                reason,
                ...(trigger ? { trigger } : {}),
                hours,
                until: new Date(this.clock() + hours * 3600000).toISOString(),
              }
            : null,
        );
        return { ok: true };
      },
      { user: source !== 'weather' },
    );
  }
  /** POST /api/programs/test-write: the supervised test, on a slot that stays off. */
  programTest() {
    return this.programJob('test write', (raw, today) => {
      const days = Array.from({ length: 14 }, (_, d) => PROGRAM_TEST.days.includes(d));
      /** @type {import('../lib/program-messages.mjs').SlotTarget} */
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
      // Written earlier today and not yet synced: nothing to write, only the sync.
      if (!readbackProblems(raw, goal).length) return goal;
      const original = this.store.get('programsOriginal')?.list.find(p => Number(p.ID) === PROGRAM_TEST.slot);
      if (!original) throw new AppError('2core has no saved copy of this slot to restore from; nothing was sent');
      if (JSON.stringify(programDefinition([raw])) !== JSON.stringify(programDefinition([original])))
        throw new AppError(
          `Program ${PROGRAM_TEST.slot} changed since 2core first saw it; restore it first. Nothing was sent`,
        );
      if (readProgram(raw).active || /[^-]/.test(raw.fullDaySchedule))
        throw new AppError(`Program ${PROGRAM_TEST.slot} is on or has watering days; nothing was sent`);
      return goal;
    });
  }
  /** POST /api/programs/restore-test-slot: puts the test slot back from 2core's first copy. */
  programRestore() {
    return this.programJob('restore test slot', (raw, today) => {
      const saved = this.store.get('programsOriginal');
      const original = saved?.list.find(p => Number(p.ID) === PROGRAM_TEST.slot);
      if (!original) throw new AppError('2core has no saved copy of this slot; nothing was sent');
      // The test leaves the slot off. Someone who turned it on since should decide.
      if (readProgram(raw).active && !readProgram(original).active)
        throw new AppError(`Program ${PROGRAM_TEST.slot} was turned on since the test; nothing was sent`);
      return restoreTarget(original, dateKey(new Date(saved.receivedAt)), today);
    });
  }
  /**
   * One owner-started program write inside one session: open Tucor's Programs
   * page, check the slot, send the editor's messages, read them back. It is
   * never retried; everything Tucor sends meanwhile is kept for review.
   * @param {string} kind
   * @param {(raw: any, today: string) => import('../lib/program-messages.mjs').SlotTarget} target
   */
  async programJob(kind, target) {
    this.writable();
    if (!this.allowProgramWrites)
      throw new AppError('Program writes are off; set ALLOW_PROGRAM_WRITES=true only for a supervised test', 403);
    const slot = PROGRAM_TEST.slot,
      today = dateKey(new Date(this.clock()));
    const record = { kind, slot, startedAt: new Date(this.clock()).toISOString(), outcome: 'not sent' };
    return this.withCurrent(async session => {
      const recorder = session.record();
      try {
        const read = await session.openPrograms();
        this.recordPrograms(read);
        const raw = read.list?.find(p => Number(p.ID) === slot);
        if (!raw) throw new AppError(`Tucor didn’t list program ${slot}; nothing was sent`);
        if (raw.allDaysArranged !== lettersFor(today))
          throw new AppError(`Tucor’s calendar doesn’t start today (${today}); nothing was sent`);
        const goal = target(raw, today);
        const { messages, changes } = writeSlot(raw, goal, readCapabilities(read.capabilities));
        Object.assign(record, { before: raw, target: goal, changes, messages });
        // Tucor says whether its cloud and the controller differ.
        const unsynced = () => (session.codes ?? []).filter(c => /^I01(:|$)/.test(c)).at(-1) === 'I01:02';
        const ready = () => {
          if (this.activeDeadline && this.clock() > this.activeDeadline)
            throw new AppError('Command expired before sending; nothing was sent', 400);
          // The write and its sync must finish inside this session, never across two.
          if (session.expiresAt && session.expiresAt - this.clock() < 300000)
            throw new AppError(
              'The Tucor session is too close to its time limit; nothing was sent. Try again in five minutes',
            );
        };
        if (!messages.length) {
          record.outcome = 'nothing to change';
          if (!unsynced()) return { ok: true, outcome: record.outcome, changes };
          ready();
          return await this.programSync(session, record, goal);
        }
        ready();
        record.outcome = 'unknown';
        session.writePrograms(messages);
        await session.settle();
        const back = await session.readPrograms();
        this.recordPrograms(back);
        await session.settle();
        const after = (session.programs?.list ?? back.list).find(p => Number(p.ID) === slot);
        const problems = readbackProblems(after, goal);
        Object.assign(record, { after, problems, outcome: problems.length ? 'readback differs' : 'not synced' });
        if (problems.length) return { ok: false, outcome: record.outcome, changes, problems };
        return await this.programSync(session, record, goal);
      } catch (e) {
        record.error = e.message;
        throw e;
      } finally {
        record.trace = recorder.stop().map(keep);
        record.codes = session.codes ?? [];
        record.finishedAt = new Date(this.clock()).toISOString();
        session.closePrograms();
        this.store.set('programTests', [record, ...this.store.get('programTests', [])].slice(0, 5));
      }
    });
  }

  /**
   * Sends the cloud's programs to the controller with Tucor's sync, which
   * program edits need. It runs only when Tucor proposes app-to-controller for
   * programs and nothing for any other section, and never changes a direction.
   * @param {any} session @param {any} record
   * @param {import('../lib/program-messages.mjs').SlotTarget} goal
   */
  async programSync(session, record, goal) {
    const slot = PROGRAM_TEST.slot,
      changes = record.changes;
    try {
      const check = syncCheck(await session.startSync());
      record.sync = { sections: check.sections, problems: check.problems };
      if (!check.ok) {
        record.outcome = 'not synced';
        return { ok: false, outcome: record.outcome, changes, problems: check.problems };
      }
      record.outcome = 'sync unknown';
      await session.executeSync();
      record.sync.finishedAt = new Date(this.clock()).toISOString();
      const back = await session.readPrograms();
      this.recordPrograms(back);
      const after = back.list.find(p => Number(p.ID) === slot);
      const problems = readbackProblems(after, goal);
      Object.assign(record, { after, problems, outcome: problems.length ? 'synced, readback differs' : 'synced' });
      return { ok: !problems.length, outcome: record.outcome, changes, problems };
    } finally {
      session.closeSync();
    }
  }

  // Weather policy: see weather-policy.mjs.
  knownHold(hours) {
    return this.weatherPolicy.knownHold(hours);
  }
  configurePolicy(patch) {
    return this.weatherPolicy.configure(patch);
  }
  weather(sample) {
    return this.weatherPolicy.decide(sample);
  }
  observeWeather(sample) {
    return this.weatherPolicy.observe(sample);
  }
  recordWeatherRead(read) {
    return this.weatherPolicy.recordRead(read);
  }

  // Watering plan: see plan-service.mjs. Local planning data; never reaches Tucor.
  plan() {
    return this.plans.plan();
  }
  intent(zone, patch) {
    return this.plans.intent(zone, patch);
  }
  seasonalAdjustment(patch) {
    return this.plans.seasonalAdjustment(patch);
  }
  planEditPreview(payload) {
    return this.plans.editPreview(payload);
  }
  planEditApply(payload) {
    return this.plans.editApply(payload);
  }
  programPreview(payload) {
    return this.plans.programPreview(payload);
  }
  rebalancePreview() {
    return this.plans.rebalancePreview();
  }
  rebalance(payload) {
    return this.plans.rebalance(payload);
  }
  planSettings(patch) {
    return this.plans.settings(patch);
  }

  /** POST /api/zones/:id/preferences */
  preferences(zone, body) {
    if (!this.current?.stations.some(s => String(s.StId) === zone)) throw new AppError('Unknown zone', 404);
    this.store.set(`zone:${zone}`, mergePreferences(this.store.get(`zone:${zone}`, {}), body));
    return { ok: true };
  }
}
