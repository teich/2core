import { createHash } from 'node:crypto';
import { compilePrograms } from '../lib/program-compiler.mjs';
import { sunrise } from '../lib/planner.mjs';
import { trace } from './telemetry.mjs';
import { DEFAULT_POLICY, evaluateWeather } from './weather.mjs';
import { DEFAULT_INTENT, DEFAULT_SETTINGS, MAX_SECONDS, SETTING_LIMITS, currentNight, nextDueDate, proposeRebalance, staggerIntents, validDateKey } from '../lib/planner.mjs';

export class AppError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
export function number(value, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new AppError(`Expected ${integer ? 'integer' : 'number'} between ${min} and ${max}`, 400);
  return value;
}
const active = state => state.stations.filter(s => s.isRunning || s.runningEntries?.length);
export const LIMITS = Object.freeze({ minMinutes: 1, maxMinutes: 240, concurrentZones: 1, issues: 20 });
const ISSUE_TEXT = 40;

export class Engine {
  constructor({ driver, store, mode = 'demo', allowControl = false, clock = Date.now, logger = () => {} }) {
    Object.assign(this, { driver, store, mode, clock, logger });
    this.allowControl = mode === 'demo' || allowControl;
    this.queue = Promise.resolve();
    this.jobs = [];
    this.inflight = new Map();
    this.store.interruptPending();
    this.current = this.store.get('lastObservation');
    this.seedPlan();
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
          try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
        }
        this.draining = false;
      });
    }
    return next;
  }
  accept(state) {
    this.current = state;
    this.error = null;
    this.observationVersion = (this.observationVersion ?? 0) + 1;
    this.store.set('lastObservation', state);
    const runs = this.store.get('runs', []);
    const handles = state.stations.flatMap(s => (s.runningEntries ?? []).map(e => `${s.StId}:${e.handleID}`));
    this.store.set('runs', runs.filter(r => handles.includes(`${r.zone}:${r.handle}`)));
    // A delay cleared at the controller or in Tucor's app must not keep answering knownHold().
    const rain = this.store.get('rain'), remaining = Number(state.status?.rainShutDown);
    if (rain && state.status?.rainShutDown != null && Number.isFinite(remaining) && remaining === 0
      && Date.parse(rain.until) - Date.parse(state.receivedAt ?? new Date(this.clock()).toISOString()) > 120000) this.store.set('rain', null);
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
        await this.driver.withSession(async s => {
          this.accept(s.snapshot());
          if (this.refreshInteractive) s.keepUntil = this.clock() + (this.driver.idleMs ?? 90000);
        }, { interactive: this.refreshInteractive, forceFresh, telemetry: t });
      } catch (e) { this.error = e.message; throw e; }
      return this.state();
    }, 1).finally(() => { this.refreshing = null; this.refreshInteractive = false; });
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
    const zones = (state?.stations ?? []).map(s => {
      const pref = this.store.get(`zone:${s.StId}`, {});
      const run = this.store.get('runs', []).find(r => r.zone === String(s.StId));
      return { id: String(s.StId), name: pref.name || s.name || s.label || `Zone ${s.StId}`, configured: Boolean(s.name), favorite: pref.favorite || false, order: pref.order ?? Number(s.StId), running: s.isRunning === null ? null : Boolean(s.isRunning || s.runningEntries?.length), owned: Boolean(run), startedAt: run?.startedAt ?? null, minutes: run?.minutes ?? null, endsAt: run?.endsAt ?? null, notes: pref.notes ?? '', issues: pref.issues ?? [] };
    }).sort((a, b) => a.order - b.order || Number(a.id) - Number(b.id));
    return {
      operations: this.store.operations(),
      apiVersion: 1, mode: this.mode, controlEnabled: this.allowControl, limits: LIMITS,
      controller: state?.controller ?? null, available: Boolean(state && age < 180000 && !this.error),
      observedAt: state?.receivedAt ?? null, error: this.error,
      connection: { ...(this.driver.connection?.() ?? { open: this.mode === 'demo' }), checking: Boolean(this.refreshing) },
      weatherSource: this.weatherSource?.describe() ?? { configured: false }, weatherReading: this.store.get('weatherReading'),
      status: state?.status ?? {}, alarms: state?.alarms ?? [], zones,
      rain: this.store.get('rain'), policy: this.store.get('policy', DEFAULT_POLICY),
      weatherDecision: this.store.get('weatherDecision'), events: this.store.events(),
      plan: this.plan(), location: this.store.get('location'),
    };
  }
  submit(key, kind, body, fn, deadline) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key ?? '')) throw new AppError('A unique Idempotency-Key is required', 400);
    const fingerprint = createHash('sha256').update(JSON.stringify([kind, Object.keys(body).sort().map(k => [k, body[k]])])).digest('hex');
    const old = this.store.command(key);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new AppError('Idempotency key was used for another command');
      const completion = this.inflight.get(key) ?? (old.state === 'succeeded' ? Promise.resolve(JSON.parse(old.result)) : Promise.reject(new AppError('Previous command failed or has an unknown outcome; refresh status before a new request')));
      completion.catch(() => {});
      return { operation: this.store.operation(key), completion };
    }
    const expires = Date.parse(deadline);
    if (!Number.isFinite(expires) || expires < this.clock() || expires > this.clock() + 120000) throw new AppError('Command expired or has an invalid deadline', 400);
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
  writable() { if (!this.allowControl) throw new AppError('Live controls are disabled; enable only for supervised validation', 403); }
  async withCurrent(fn, { user = true } = {}) {
    return this.driver.withSession(async session => {
      this.accept(session.snapshot());
      if (this.activeDeadline && this.clock() > this.activeDeadline) throw new AppError('Command expired while connecting; nothing was sent', 400);
      const result = await fn(session);
      this.accept(session.snapshot());
      return result ?? { ok: true };
    }, { interactive: user, user, telemetry: this.activeTrace ?? trace(this.logger), deadline: this.activeDeadline });
  }
  async start(zone, minutes) {
    this.writable(); number(minutes, LIMITS.minMinutes, LIMITS.maxMinutes, true);
    return this.withCurrent(async session => {
      if (!this.current.stations.some(s => String(s.StId) === zone)) throw new AppError('Unknown zone', 404);
      if (this.current.stations.some(s => s.isRunning === null || s.runningEntries === null)) throw new AppError('Station activity is unknown; refresh before starting');
      if (active(this.current).length) throw new AppError('Another zone is running. Stop your current test before starting the next');
      if (this.current.status.rainShutDown == null || !Number.isFinite(Number(this.current.status.rainShutDown))) throw new AppError('Rain delay status is unknown; refresh before starting');
      if (Number(this.current.status.rainShutDown) > 0) throw new AppError('Rain delay is active. Manual operation during rain delay is not yet validated');
      if (Number(this.current.status.controllerMode) !== 2) throw new AppError('Controller must already be in Automatic mode');
      const started = await session.start(zone, minutes);
      const now = this.clock();
      const run = { zone, handle: started.handle, minutes, startedAt: new Date(now).toISOString(), endsAt: new Date(now + minutes * 60000).toISOString() };
      this.store.set('runs', [run]);
      return { ok: true, run };
    });
  }
  async stop(zone = null) {
    this.writable();
    return this.withCurrent(async session => {
      const runs = this.store.get('runs', []).filter(r => zone === null || r.zone === zone);
      if (!runs.length && zone && active(this.current).some(s => String(s.StId) === zone)) throw new AppError('This run was started outside 2core; stop it with the controller');
      if (runs.length) await session.stop(runs.map(r => r.handle));
      this.store.set('runs', this.store.get('runs', []).filter(r => !runs.some(stop => stop.handle === r.handle)));
      return { ok: true };
    });
  }
  async next(zone, minutes) {
    this.writable(); number(minutes, LIMITS.minMinutes, LIMITS.maxMinutes, true);
    // Check the target before stopping anything. Both steps run under one command.
    await this.withCurrent(async () => {
      if (!this.current.stations.some(s => String(s.StId) === zone)) throw new AppError('Unknown zone', 404);
      const owned = this.store.get('runs', []);
      if (active(this.current).some(s => !owned.some(r => r.zone === String(s.StId)))) throw new AppError('A zone was started outside 2core; stop it with the controller');
    });
    await this.stop();
    // start performs all safety checks again after the confirmed stop.
    return this.start(zone, minutes);
  }
  async rain(hours, source = 'manual', reason = 'Manual rain delay', trigger = null) {
    this.writable(); number(hours, 0, 999, true);
    return this.withCurrent(async session => {
      if (Number(this.current.status.controllerMode) !== 2) throw new AppError('Rain delay requires Automatic mode');
      const remaining = Number(this.current.status.rainShutDown);
      if (this.current.status.rainShutDown == null || !Number.isFinite(remaining)) throw new AppError('Rain delay status is unknown; refresh before changing it');
      const previous = this.store.get('rain');
      if (source === 'weather' && remaining > 0) {
        const expected = previous ? (Date.parse(previous.until) - this.clock()) / 1000 : 0;
        if (previous?.source !== 'weather' || Math.abs(remaining - expected) > 120) return { ok: true, preserved: true, reason: 'Existing manual or external rain delay preserved' };
        if (remaining >= hours * 3600 - 3600) return { ok: true, preserved: true, reason: 'Weather delay already covers this period' };
      }
      await session.rain(hours);
      this.store.set('rain', hours ? { source, reason, ...(trigger ? { trigger } : {}), hours, until: new Date(this.clock() + hours * 3600000).toISOString() } : null);
      return { ok: true };
    }, { user: source !== 'weather' });
  }
  // Answers from 2core's own record whether a weather hold is already in place, without asking Tucor.
  // A delay set at the controller is only discovered, and preserved, when rain() connects.
  knownHold(hours) {
    const rain = this.store.get('rain');
    const remaining = rain ? Date.parse(rain.until) - this.clock() : 0;
    if (!(remaining > 0)) return null;
    if (rain.source !== 'weather') return 'Existing manual rain delay preserved';
    if (remaining >= hours * 3600000 - 3600000) return 'Weather delay already covers this period';
    return null;
  }
  configurePolicy(patch) {
    const policy = { ...this.store.get('policy', DEFAULT_POLICY), ...patch };
    if (!['off', 'observe', 'automatic'].includes(policy.mode)) throw new AppError('Invalid weather policy mode', 400);
    for (const k of Object.keys(patch)) if (!Object.hasOwn(DEFAULT_POLICY, k)) throw new AppError('Unknown weather setting', 400);
    number(policy.intensityMmH, 0.01, 100); number(policy.accumulationMm, 0.1, 500);
    number(policy.forecastMm, 0.1, 500); number(policy.forecastProbability, 1, 100);
    number(policy.holdHours, 1, 72, true);
    this.store.set('policy', policy);
    return { ok: true, policy };
  }
  async weather(sample) {
    for (const key of ['intensityMmH', 'accumulationMm', 'forecastMm', 'forecastProbability']) {
      if (sample[key] !== undefined && sample[key] !== null) number(sample[key], 0, key === 'forecastProbability' ? 100 : 10000);
    }
    const policy = this.store.get('policy', DEFAULT_POLICY);
    const decision = { ...evaluateWeather(sample, policy, this.clock()), at: new Date(this.clock()).toISOString(), mode: policy.mode, applied: false };
    this.store.set('weatherDecision', decision);
    if (policy.mode === 'automatic' && decision.wet && this.allowControl) {
      const known = this.knownHold(policy.holdHours);
      if (known) decision.preserved = known;
      else {
        const result = await this.rain(policy.holdHours, 'weather', decision.reason, decision.trigger);
        decision.applied = !result.preserved;
        decision.preserved = result.reason;
      }
    }
    if (decision.wet && !this.allowControl) decision.blocked = 'Live control is disabled';
    this.store.set('weatherDecision', decision);
    return { ok: true, decision };
  }
  // In-process weather source: serialized with commands, recorded like one.
  observeWeather(sample) {
    return this.serial(async () => {
      try {
        const { decision } = await this.weather(sample);
        if (decision.applied) this.store.event('/api/weather', { outcome: 'confirmed', message: decision.reason });
        return decision;
      } catch (e) {
        this.store.set('weatherDecision', { wet: true, reason: `Rain delay not set: ${e.message}`, at: new Date(this.clock()).toISOString(), mode: this.store.get('policy', DEFAULT_POLICY).mode, applied: false });
        this.store.event('/api/weather', { outcome: 'failed', message: e.message });
        throw e;
      }
    });
  }
  // The weather source's health, kept apart from decisions: the last good sample survives a failed read.
  recordWeatherRead({ sample = null, error = null }) {
    const at = new Date(this.clock()).toISOString();
    const previous = this.store.get('weatherReading') ?? {};
    this.store.set('weatherReading', error ? { ...previous, error, errorAt: at } : { sample, at, error: null });
    // The station's position gives the watering plan its sunrise times.
    const station = this.weatherSource?.describe()?.station;
    if (!error && Number.isFinite(station?.latitude) && Number.isFinite(station?.longitude)) this.store.set('location', { latitude: station.latitude, longitude: station.longitude });
  }
  // Watering intentions are local planning data. They never reach Tucor.
  seedPlan() {
    const saved = this.store.prefixed('intent:');
    const seeded = staggerIntents(saved, currentNight(new Date(this.clock())));
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [id, intent] of Object.entries(seeded)) {
        if (intent.firstDue !== saved[id].firstDue) this.store.set(`intent:${id}`, intent);
      }
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  plan() {
    const intents = Object.fromEntries(Object.entries(this.store.prefixed('intent:')).map(([id, intent]) => [id, { ...DEFAULT_INTENT, ...intent }]));
    return { settings: { ...DEFAULT_SETTINGS, ...this.store.get('planSettings', {}) }, intents };
  }
  intent(zone, patch) {
    if (!this.current?.stations.some(s => String(s.StId) === zone)) throw new AppError('Unknown zone', 404);
    const next = { ...DEFAULT_INTENT, ...this.store.get(`intent:${zone}`, {}) };
    const previous = { ...next };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'seconds') next.seconds = v === null ? null : number(v, 1, MAX_SECONDS, true);
      else if (k === 'seasonalPercent') next.seasonalPercent = number(v, 50, 200, true);
      else if (k === 'cadence') {
        const keys = v && typeof v === 'object' ? Object.keys(v) : [];
        if (v !== null && !(keys.length === 1 && (keys[0] === 'every' ? number(v.every, 1, 30, true) : keys[0] === 'perWeek' && number(v.perWeek, 1, 6, true)))) throw new AppError('Cadence must be {every: days} or {perWeek: times}', 400);
        next.cadence = v;
      } else if (k === 'enabled' || k === 'waterDuringRain') { if (typeof v !== 'boolean') throw new AppError(`Invalid ${k} flag`, 400); next[k] = v; }
      else if (k === 'firstDue') { if (v !== null && !validDateKey(v)) throw new AppError('First due date must be YYYY-MM-DD', 400); next.firstDue = v; }
      else throw new AppError('Unknown intent field', 400);
    }
    if (patch.cadence && previous.cadence && previous.firstDue && !Object.hasOwn(patch, 'firstDue')
      && JSON.stringify(patch.cadence) !== JSON.stringify(previous.cadence)) {
      next.firstDue = nextDueDate(previous, currentNight(new Date(this.clock())));
    }
    // Allocate only this new intention around saved ones. Existing phases remain.
    const seeded = staggerIntents({ ...this.plan().intents, [zone]: next }, currentNight(new Date(this.clock())));
    this.store.set(`intent:${zone}`, seeded[zone]);
    return { ok: true, intent: seeded[zone] };
  }
  seasonalAdjustment(patch) {
    if (Object.keys(patch).length !== 1 || !Object.hasOwn(patch, 'seasonalPercent')) throw new AppError('Expected seasonalPercent only', 400);
    const seasonalPercent = number(patch.seasonalPercent, 50, 200, true);
    const saved = this.plan().intents;
    const ids = new Set([...Object.keys(saved), ...(this.current?.stations ?? []).map(s => String(s.StId))]);
    if (!ids.size) throw new AppError('Load the zones before setting seasonal adjustment');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) this.store.set(`intent:${id}`, { ...DEFAULT_INTENT, ...saved[id], seasonalPercent });
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    return { ok: true, plan: this.plan() };
  }
  programPreview(payload = {}) {
    if (Object.keys(payload).some(k => k !== 'enabledOverrides') ||
      payload.enabledOverrides != null && (typeof payload.enabledOverrides !== 'object' || Array.isArray(payload.enabledOverrides))) {
      throw new AppError('Expected enabledOverrides only', 400);
    }
    const plan = this.plan(), state = this.state();
    const zones = state.zones.filter(z => z.configured || plan.intents[z.id]);
    const enabledOverrides = payload.enabledOverrides ?? {};
    for (const [id, enabled] of Object.entries(enabledOverrides)) {
      if (!zones.some(z => z.id === id) || typeof enabled !== 'boolean') throw new AppError('Expected known zone ids with boolean overrides', 400);
    }
    const location = this.store.get('location');
    return compilePrograms({ zones, ...plan, enabledOverrides, start: currentNight(new Date(this.clock())),
      sunriseAt: d => location ? sunrise(d, location.latitude, location.longitude) : null });
  }
  rebalancePreview() {
    const plan = this.plan(), start = currentNight(new Date(this.clock()));
    const token = createHash('sha256').update(JSON.stringify({ plan, night: start.toISOString() })).digest('hex');
    return { token, ...proposeRebalance(plan.intents, start) };
  }
  rebalance({ token }) {
    const proposal = this.rebalancePreview();
    if (!token || token !== proposal.token) throw new AppError('The plan changed. Review the updated rebalance before confirming.', 409);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const change of proposal.changes) {
        const intent = this.store.get(`intent:${change.zone}`);
        this.store.set(`intent:${change.zone}`, { ...intent, firstDue: change.firstDue });
      }
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    return { ok: true, plan: this.plan(), changes: proposal.changes };
  }
  planSettings(patch) {
    const next = { ...this.plan().settings };
    for (const [k, v] of Object.entries(patch)) {
      if (!Object.hasOwn(SETTING_LIMITS, k)) throw new AppError('Unknown plan setting', 400);
      next[k] = number(v, ...SETTING_LIMITS[k], true);
    }
    this.store.set('planSettings', next);
    return { ok: true, settings: next };
  }
  preferences(zone, body) {
    if (!this.current?.stations.some(s => String(s.StId) === zone)) throw new AppError('Unknown zone', 404);
    const current = this.store.get(`zone:${zone}`, {});
    const next = { ...current };
    for (const k of ['name', 'notes']) if (body[k] !== undefined) {
      if (typeof body[k] !== 'string' || body[k].length > (k === 'name' ? 80 : 1000)) throw new AppError('Invalid zone text', 400);
      next[k] = body[k];
    }
    if (body.favorite !== undefined) { if (typeof body.favorite !== 'boolean') throw new AppError('Invalid favorite', 400); next.favorite = body.favorite; }
    if (body.order !== undefined) next.order = number(body.order, 0, 1000, true);
    if (body.issues !== undefined) {
      // Problems spotted on a walk: short labels with the time they were flagged.
      if (!Array.isArray(body.issues) || body.issues.length > LIMITS.issues) throw new AppError(`Expected up to ${LIMITS.issues} issues`, 400);
      next.issues = body.issues.map(item => {
        if (!item || typeof item.issue !== 'string' || !item.issue.trim() || item.issue.length > ISSUE_TEXT || !Number.isFinite(Date.parse(item.at))) throw new AppError('Invalid issue', 400);
        return { issue: item.issue.trim(), at: new Date(item.at).toISOString() };
      });
    }
    this.store.set(`zone:${zone}`, next);
    return { ok: true };
  }
}
