// The automatic rain-delay policy: off, observe (log what it would do) or
// automatic (set a delay when a threshold is met). It never shortens or
// replaces a delay someone set by hand, and missing readings never count as dry.
import { DEFAULT_POLICY, evaluateWeather } from './weather.mjs';
import { AppError, number } from './validation.mjs';

// The weather log: one reading every 15 minutes at most, for a week, so a delay
// that should have happened can be replayed against the thresholds.
const LOG_EVERY_MS = 15 * 60000;
const LOG_KEPT = 7 * 24 * 4;
const LOGGED = ['intensityMmH', 'accumulationMm', 'forecastMm', 'forecastExpectedMm', 'forecastProbability'];
const round = x => (typeof x === 'number' ? Math.round(x * 100) / 100 : null);

export class WeatherPolicy {
  /** @param {import('./engine.mjs').Engine} engine For the store, clock, command queue and rain(). */
  constructor(engine) {
    this.engine = engine;
  }
  get store() {
    return this.engine.store;
  }
  now() {
    return new Date(this.engine.clock()).toISOString();
  }
  /** The saved policy; settings it predates take their defaults, and retired ones are dropped. */
  policy() {
    const saved = this.store.get('policy', {});
    return Object.fromEntries(Object.entries(DEFAULT_POLICY).map(([k, v]) => [k, saved[k] ?? v]));
  }

  /**
   * Answers from 2core's own record whether a weather hold is already in place, without asking Tucor.
   * A delay set at the controller is only discovered, and preserved, when rain() connects.
   */
  knownHold(hours) {
    const rain = this.store.get('rain');
    const remaining = rain ? Date.parse(rain.until) - this.engine.clock() : 0;
    if (!(remaining > 0)) return null;
    if (rain.source !== 'weather') return 'Existing manual rain delay preserved';
    if (remaining >= hours * 3600000 - 3600000) return 'Weather delay already covers this period';
    return null;
  }

  /** POST /api/policy */
  configure(patch) {
    const policy = { ...this.policy(), ...patch };
    if (!['off', 'observe', 'automatic'].includes(policy.mode)) throw new AppError('Invalid weather policy mode', 400);
    for (const k of Object.keys(patch))
      if (!Object.hasOwn(DEFAULT_POLICY, k)) throw new AppError('Unknown weather setting', 400);
    number(policy.intensityMmH, 0.01, 100);
    number(policy.accumulationMm, 0.1, 500);
    number(policy.forecastExpectedMm, 0.1, 500);
    number(policy.holdHours, 1, 72, true);
    this.store.set('policy', policy);
    return { ok: true, policy };
  }

  /** POST /api/weather, and each in-process reading: decide, and in automatic mode act. */
  async decide(sample) {
    for (const key of ['intensityMmH', 'accumulationMm', 'forecastMm', 'forecastExpectedMm', 'forecastProbability']) {
      if (sample[key] !== undefined && sample[key] !== null)
        number(sample[key], 0, key === 'forecastProbability' ? 100 : 10000);
    }
    const policy = this.policy();
    const decision = /** @type {Record<string, any>} */ ({
      ...evaluateWeather(sample, policy, this.engine.clock()),
      at: this.now(),
      mode: policy.mode,
      applied: false,
    });
    this.store.set('weatherDecision', decision);
    if (policy.mode === 'automatic' && decision.wet && this.engine.allowControl) {
      const known = this.knownHold(policy.holdHours);
      if (known) decision.preserved = known;
      else {
        const result = await this.engine.rain(policy.holdHours, 'weather', decision.reason, decision.trigger);
        decision.applied = !result.preserved;
        decision.preserved = result.reason;
      }
    }
    if (decision.wet && !this.engine.allowControl) decision.blocked = 'Live control is disabled';
    this.store.set('weatherDecision', decision);
    this.log(sample, decision);
    return { ok: true, decision };
  }

  /** Adds a reading and its decision to the weather log, at most every 15 minutes. */
  log(sample, decision) {
    const log = this.store.get('weatherLog', []);
    if (log[0] && this.engine.clock() - Date.parse(log[0].at) < LOG_EVERY_MS) return;
    const entry = { at: decision.at, wet: decision.wet, trigger: decision.trigger?.kind ?? null };
    for (const key of LOGGED) entry[key] = round(sample[key]);
    this.store.set('weatherLog', [entry, ...log].slice(0, LOG_KEPT));
  }
  /** GET /api/weather-log: the last week of readings, newest first, with the policy they were judged by. */
  history() {
    return { policy: this.policy(), log: this.store.get('weatherLog', []) };
  }

  /** In-process weather source: serialized with commands, recorded like one. */
  observe(sample) {
    return this.engine.serial(async () => {
      try {
        const { decision } = await this.decide(sample);
        if (decision.applied) this.store.event('/api/weather', { outcome: 'confirmed', message: decision.reason });
        return decision;
      } catch (e) {
        this.store.set('weatherDecision', {
          wet: true,
          reason: `Rain delay not set: ${e.message}`,
          at: this.now(),
          mode: this.policy().mode,
          applied: false,
        });
        this.store.event('/api/weather', { outcome: 'failed', message: e.message });
        throw e;
      }
    });
  }

  /** The weather source's health, kept apart from decisions: the last good sample survives a failed read. */
  recordRead({ sample = null, error = null }) {
    const at = this.now();
    const previous = this.store.get('weatherReading') ?? {};
    this.store.set('weatherReading', error ? { ...previous, error, errorAt: at } : { sample, at, error: null });
    // The station's position gives the watering plan its sunrise times.
    const station = this.engine.weatherSource?.describe()?.station;
    if (!error && Number.isFinite(station?.latitude) && Number.isFinite(station?.longitude))
      this.store.set('location', { latitude: station.latitude, longitude: station.longitude });
  }
}
