import { createHash } from 'node:crypto';
import { DEFAULT_POLICY, evaluateWeather } from './weather.mjs';

export class AppError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
export function number(value, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new AppError(`Expected ${integer ? 'integer' : 'number'} between ${min} and ${max}`, 400);
  return value;
}
const active = state => state.stations.filter(s => s.isRunning || s.runningEntries?.length);

export class Engine {
  constructor({ driver, store, mode = 'demo', allowControl = false, clock = Date.now }) {
    Object.assign(this, { driver, store, mode, clock });
    this.allowControl = mode === 'demo' || allowControl;
    this.queue = Promise.resolve();
    this.current = null;
    this.error = null;
  }
  serial(fn) { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  accept(state) {
    this.current = state;
    this.error = null;
    const runs = this.store.get('runs', []);
    const handles = state.stations.flatMap(s => (s.runningEntries ?? []).map(e => `${s.StId}:${e.handleID}`));
    this.store.set('runs', runs.filter(r => handles.includes(`${r.zone}:${r.handle}`)));
  }
  async refresh() {
    return this.serial(async () => {
      try { await this.driver.withSession(async s => this.accept(s.snapshot())); }
      catch (e) { this.error = e.message; throw e; }
      return this.state();
    });
  }
  state() {
    const state = this.current;
    const age = state ? this.clock() - Date.parse(state.receivedAt) : Infinity;
    const zones = (state?.stations ?? []).map(s => {
      const pref = this.store.get(`zone:${s.StId}`, {});
      const run = this.store.get('runs', []).find(r => r.zone === String(s.StId));
      return { id: String(s.StId), name: pref.name || s.name || s.label || `Zone ${s.StId}`, configured: Boolean(s.name), favorite: pref.favorite || false, order: pref.order ?? Number(s.StId), running: s.isRunning === null ? null : Boolean(s.isRunning || s.runningEntries?.length), owned: Boolean(run), endsAt: run?.endsAt ?? null, ...{ notes: pref.notes ?? '' } };
    }).sort((a, b) => a.order - b.order || Number(a.id) - Number(b.id));
    return {
      apiVersion: 1, mode: this.mode, controlEnabled: this.allowControl,
      controller: state?.controller ?? null, available: Boolean(state && age < 180000 && !this.error),
      observedAt: state?.receivedAt ?? null, error: this.error,
      status: state?.status ?? {}, alarms: state?.alarms ?? [], zones,
      rain: this.store.get('rain'), policy: this.store.get('policy', DEFAULT_POLICY),
      weatherDecision: this.store.get('weatherDecision'), events: this.store.events(),
    };
  }
  async command(key, kind, body, fn, deadline) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key ?? '')) throw new AppError('A unique Idempotency-Key is required', 400);
    const fingerprint = createHash('sha256').update(JSON.stringify([kind, Object.keys(body).sort().map(k => [k, body[k]])])).digest('hex');
    return this.serial(async () => {
      const old = this.store.command(key);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new AppError('Idempotency key was used for another command');
        if (old.state !== 'succeeded') throw new AppError('Previous command failed or has an unknown outcome; refresh status before a new request');
        return JSON.parse(old.result);
      }
      const expires = Date.parse(deadline);
      if (!Number.isFinite(expires) || expires < this.clock() || expires > this.clock() + 120000) throw new AppError('Command expired or has an invalid deadline', 400);
      this.store.begin(key, fingerprint);
      this.activeDeadline = expires;
      try {
        const result = await fn();
        this.store.finish(key, 'succeeded', result);
        this.store.event(kind, { ...body, outcome: 'confirmed' });
        return result;
      } catch (e) {
        this.error = e instanceof AppError ? this.error : e.message;
        this.store.finish(key, 'failed', { error: e.message });
        this.store.event(kind, { ...body, outcome: 'failed', message: e.message });
        throw e;
      } finally {
        this.activeDeadline = null;
      }
    });
  }
  writable() { if (!this.allowControl) throw new AppError('Live controls are disabled; enable only for supervised validation', 403); }
  async withCurrent(fn) {
    return this.driver.withSession(async session => {
      this.accept(session.snapshot());
      if (this.activeDeadline && this.clock() > this.activeDeadline) throw new AppError('Command expired while connecting; nothing was sent', 400);
      const result = await fn(session);
      this.accept(session.snapshot());
      return result ?? { ok: true };
    });
  }
  async start(zone, minutes) {
    this.writable(); number(minutes, 1, 60, true);
    return this.withCurrent(async session => {
      if (!this.current.stations.some(s => String(s.StId) === zone)) throw new AppError('Unknown zone', 404);
      if (this.current.stations.some(s => s.isRunning === null || s.runningEntries === null)) throw new AppError('Station activity is unknown; refresh before starting');
      if (active(this.current).length) throw new AppError('Another zone is running. Stop your current test before starting the next');
      if (this.current.status.rainShutDown == null || !Number.isFinite(Number(this.current.status.rainShutDown))) throw new AppError('Rain delay status is unknown; refresh before starting');
      if (Number(this.current.status.rainShutDown) > 0) throw new AppError('Rain delay is active. Manual operation during rain delay is not yet validated');
      if (Number(this.current.status.controllerMode) !== 2) throw new AppError('Controller must already be in Automatic mode');
      const started = await session.start(zone, minutes);
      const run = { zone, handle: started.handle, endsAt: new Date(this.clock() + minutes * 60000).toISOString() };
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
  async rain(hours, source = 'manual', reason = 'Manual rain delay') {
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
      this.store.set('rain', hours ? { source, reason, until: new Date(this.clock() + hours * 3600000).toISOString() } : null);
      return { ok: true };
    });
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
      const result = await this.rain(policy.holdHours, 'weather', decision.reason);
      decision.applied = !result.preserved;
      decision.preserved = result.reason;
    }
    if (decision.wet && !this.allowControl) decision.blocked = 'Live control is disabled';
    this.store.set('weatherDecision', decision);
    return { ok: true, decision };
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
    this.store.set(`zone:${zone}`, next);
    return { ok: true };
  }
}
