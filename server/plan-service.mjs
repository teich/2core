// The watering plan on the bridge: each zone's intention (run length, how
// often, seasonal percentage…), night settings, reviewed edits, rebalancing
// and the controller-program dry run. Local planning data only; nothing here
// ever reaches Tucor. The planning math lives in lib/ and is shared with the web app.
import { createHash } from 'node:crypto';
import { assessPlan, verifiedAlternatives } from '../lib/plan-feasibility.mjs';
import { compilePrograms } from '../lib/program-compiler.mjs';
import {
  DEFAULT_INTENT,
  DEFAULT_SETTINGS,
  MAX_SECONDS,
  SETTING_LIMITS,
  currentNight,
  nextDueDate,
  proposeRebalance,
  staggerIntents,
  sunrise,
  validDateKey,
} from '../lib/planner.mjs';
import { AppError, isObject, number } from './validation.mjs';

const EDIT_KEYS = ['intents', 'settings', 'seasonalPercent', 'seasonalZoneIds', 'rebalanceToken'];
const APPLY_KEYS = ['change', 'token', 'alternativeId', 'saveUnresolved'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class PlanService {
  /** @param {import('./engine.mjs').Engine} engine For the store, clock and latest controller observation. */
  constructor(engine) {
    this.engine = engine;
  }
  get store() {
    return this.engine.store;
  }
  tonight() {
    return currentNight(new Date(this.engine.clock()));
  }
  stationIds() {
    return (this.engine.current?.stations ?? []).map(s => String(s.StId));
  }
  knownZone(id) {
    return Boolean(this.engine.current?.stations.some(s => String(s.StId) === id));
  }
  sunriseAt() {
    const location = this.store.get('location');
    return d => (location ? sunrise(d, location.latitude, location.longitude) : null);
  }
  /** Zones to plan: named ones, plus any unnamed zone that already has a complete intention. */
  plannable(plan) {
    return this.engine
      .state()
      .zones.filter(z => z.configured || (plan.intents[z.id]?.seconds && plan.intents[z.id]?.cadence));
  }

  /** Gives intentions without a first watering date one, spread across nights. */
  seed() {
    const saved = this.store.prefixed('intent:');
    const seeded = staggerIntents(saved, this.tonight());
    this.store.transaction(() => {
      for (const [id, intent] of Object.entries(seeded))
        if (intent.firstDue !== saved[id].firstDue) this.store.set(`intent:${id}`, intent);
    });
  }

  /** The saved plan: settings, intentions by zone id, and the seasonal comparison zones. */
  plan() {
    const intents = Object.fromEntries(
      Object.entries(this.store.prefixed('intent:')).map(([id, intent]) => [id, { ...DEFAULT_INTENT, ...intent }]),
    );
    return {
      settings: { ...DEFAULT_SETTINGS, ...this.store.get('planSettings', {}) },
      intents,
      // By default, compare with the vineyard and any zone that is off for now.
      seasonalZoneIds: this.store.get(
        'planSeasonalZones',
        (this.engine.current?.stations ?? [])
          .filter(s => /vineyard/i.test(s.name ?? '') || intents[String(s.StId)]?.enabled === false)
          .map(s => String(s.StId)),
      ),
    };
  }

  /** Validates a zone's intent patch and returns the resulting intention, phased among the others. */
  intentCandidate(zone, patch, plan = this.plan()) {
    if (!isObject(patch)) throw new AppError('Expected intent patch', 400);
    if (!this.knownZone(zone)) throw new AppError('Unknown zone', 404);
    const next = { ...DEFAULT_INTENT, ...plan.intents[zone] };
    const previous = { ...next };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'seconds') next.seconds = v === null ? null : number(v, 1, MAX_SECONDS, true);
      else if (k === 'seasonalPercent') next.seasonalPercent = number(v, 50, 200, true);
      else if (k === 'cadence') {
        const keys = v && typeof v === 'object' ? Object.keys(v) : [];
        if (
          v !== null &&
          !(
            keys.length === 1 &&
            (keys[0] === 'every'
              ? number(v.every, 1, 30, true)
              : keys[0] === 'perWeek' && number(v.perWeek, 1, 6, true))
          )
        )
          throw new AppError('Cadence must be {every: days} or {perWeek: times}', 400);
        next.cadence = v;
      } else if (k === 'enabled' || k === 'waterDuringRain') {
        if (typeof v !== 'boolean') throw new AppError(`Invalid ${k} flag`, 400);
        next[k] = v;
      } else if (k === 'firstDue') {
        if (v !== null && !validDateKey(v)) throw new AppError('First due date must be YYYY-MM-DD', 400);
        next.firstDue = v;
      } else throw new AppError('Unknown intent field', 400);
    }
    // A new rhythm starts from the next watering the old one had planned.
    if (
      patch.cadence &&
      previous.cadence &&
      previous.firstDue &&
      !Object.hasOwn(patch, 'firstDue') &&
      JSON.stringify(patch.cadence) !== JSON.stringify(previous.cadence)
    ) {
      next.firstDue = nextDueDate(previous, this.tonight());
    }
    // Allocate only this new intention around saved ones. Existing phases remain.
    const seeded = staggerIntents({ ...plan.intents, [zone]: next }, this.tonight());
    return seeded[zone];
  }

  /** POST /api/zones/:id/intent — saves one zone's intention without review. */
  intent(zone, patch) {
    const seasonalZoneIds = this.plan().seasonalZoneIds;
    const intent = this.intentCandidate(zone, patch);
    this.store.set('planSeasonalZones', seasonalZoneIds);
    this.store.set(`intent:${zone}`, intent);
    return { ok: true, intent };
  }

  /** POST /api/plan/seasonal — sets every zone's seasonal percentage. */
  seasonalAdjustment(patch) {
    if (Object.keys(patch).length !== 1 || !Object.hasOwn(patch, 'seasonalPercent'))
      throw new AppError('Expected seasonalPercent only', 400);
    const seasonalPercent = number(patch.seasonalPercent, 50, 200, true);
    const saved = this.plan().intents;
    const ids = new Set([...Object.keys(saved), ...this.stationIds()]);
    if (!ids.size) throw new AppError('Load the zones before setting seasonal adjustment');
    this.store.transaction(() => {
      for (const id of ids) this.store.set(`intent:${id}`, { ...DEFAULT_INTENT, ...saved[id], seasonalPercent });
    });
    return { ok: true, plan: this.plan() };
  }

  /** Applies a validated change (see EDIT_KEYS) to a copy of `base`. */
  prepareEdit(change, base = this.plan()) {
    if (!isObject(change) || Object.keys(change).some(k => !EDIT_KEYS.includes(k)))
      throw new AppError('Invalid plan change', 400);
    const next = structuredClone(base);
    if (Object.hasOwn(change, 'rebalanceToken')) {
      const proposal = this.rebalancePreview();
      if (!change.rebalanceToken || change.rebalanceToken !== proposal.token)
        throw new AppError('The plan changed. Review the rebalance again.', 409);
      for (const c of proposal.changes) next.intents[c.zone] = { ...next.intents[c.zone], firstDue: c.firstDue };
    }
    if (Object.hasOwn(change, 'seasonalZoneIds')) {
      const ids = change.seasonalZoneIds;
      if (
        !Array.isArray(ids) ||
        new Set(ids).size !== ids.length ||
        ids.some(id => typeof id !== 'string' || !this.knownZone(id))
      )
        throw new AppError('Choose known seasonal zones', 400);
      next.seasonalZoneIds = [...ids].sort((a, b) => Number(a) - Number(b));
    }
    if (Object.hasOwn(change, 'seasonalPercent')) {
      const seasonalPercent = number(change.seasonalPercent, 50, 200, true);
      for (const id of new Set([...Object.keys(next.intents), ...this.stationIds()]))
        next.intents[id] = { ...DEFAULT_INTENT, ...next.intents[id], seasonalPercent };
    }
    if (Object.hasOwn(change, 'intents')) {
      if (!isObject(change.intents)) throw new AppError('Expected zone patches', 400);
      for (const [id, patch] of Object.entries(change.intents))
        next.intents[id] = this.intentCandidate(id, patch, next);
    }
    if (Object.hasOwn(change, 'settings')) {
      if (!isObject(change.settings)) throw new AppError('Expected night settings', 400);
      for (const [key, value] of Object.entries(change.settings)) {
        if (!Object.hasOwn(SETTING_LIMITS, key)) throw new AppError('Unknown plan setting', 400);
        next.settings[key] = number(value, ...SETTING_LIMITS[key], true);
      }
    }
    return next;
  }

  /**
   * POST /api/plan/edit-preview — checks a draft against the saved plan. The
   * token binds the review to this saved plan, zone list, location and night.
   */
  editPreview(payload = {}) {
    if (Object.keys(payload).some(k => k !== 'change')) throw new AppError('Expected change only', 400);
    const change = payload.change ?? {},
      before = this.plan(),
      after = this.prepareEdit(change, before);
    const zones = this.plannable(after).map(({ id, name }) => ({ id, name }));
    const location = this.store.get('location'),
      start = this.tonight();
    const token = hash({ before, change, zones, location, night: start.toISOString() });
    const input = { zones, before, after, seasonalZoneIds: after.seasonalZoneIds, start, sunriseAt: this.sunriseAt() };
    const assessment = assessPlan(input);
    return {
      token,
      plan: after,
      assessment,
      seasonalZones: zones.filter(z => after.seasonalZoneIds.includes(z.id)),
      alternatives: verifiedAlternatives({
        ...input,
        editedZoneIds: Object.keys(change.intents ?? {}),
        report: assessment,
      }),
    };
  }

  /** POST /api/plan/edit-apply — saves a reviewed draft, an alternative, or an explicitly unfinished plan. */
  editApply(payload) {
    if (
      Object.keys(payload).some(k => !APPLY_KEYS.includes(k)) ||
      (payload.saveUnresolved != null && typeof payload.saveUnresolved !== 'boolean')
    )
      throw new AppError('Invalid plan review', 400);
    const reviewed = this.editPreview({ change: payload.change });
    if (!payload.token || payload.token !== reviewed.token)
      throw new AppError('The saved plan or night changed. Check this draft again before saving.', 409);
    let plan = reviewed.plan,
      assessment = reviewed.assessment;
    if (payload.alternativeId != null) {
      const alternative = reviewed.alternatives.find(a => a.id === payload.alternativeId);
      if (!alternative) throw new AppError('Review an available adjustment before saving', 400);
      plan = this.prepareEdit(alternative.adjustments, plan);
      assessment = alternative.assessment;
    }
    if (assessment.status === 'needs-adjustment' && payload.saveUnresolved !== true)
      throw new AppError('This draft needs an adjustment. Choose one or explicitly save it as unfinished.', 409);
    this.store.transaction(() => {
      for (const [id, intent] of Object.entries(plan.intents)) this.store.set(`intent:${id}`, intent);
      this.store.set('planSettings', plan.settings);
      this.store.set('planSeasonalZones', plan.seasonalZoneIds);
    });
    return { ok: true, plan: this.plan(), assessment };
  }

  /** POST /api/plan/program-preview — compiles the saved plan into controller programs (dry run). */
  programPreview(payload = {}) {
    if (
      Object.keys(payload).some(k => k !== 'enabledOverrides') ||
      (payload.enabledOverrides != null && !isObject(payload.enabledOverrides))
    )
      throw new AppError('Expected enabledOverrides only', 400);
    const plan = this.plan(),
      zones = this.plannable(plan);
    const enabledOverrides = payload.enabledOverrides ?? {};
    for (const [id, enabled] of Object.entries(enabledOverrides)) {
      if (!zones.some(z => z.id === id) || typeof enabled !== 'boolean')
        throw new AppError('Expected known zone ids with boolean overrides', 400);
    }
    return compilePrograms({ zones, ...plan, enabledOverrides, start: this.tonight(), sunriseAt: this.sunriseAt() });
  }

  /** POST /api/plan/rebalance-preview — first-due dates that even out the nights, with a review token. */
  rebalancePreview() {
    const plan = this.plan(),
      start = this.tonight();
    return { token: hash({ plan, night: start.toISOString() }), ...proposeRebalance(plan.intents, start) };
  }

  /** POST /api/plan/rebalance — applies a reviewed rebalance if the plan hasn't changed since. */
  rebalance({ token }) {
    const proposal = this.rebalancePreview();
    if (!token || token !== proposal.token)
      throw new AppError('The plan changed. Review the updated rebalance before confirming.', 409);
    this.store.transaction(() => {
      for (const change of proposal.changes) {
        const intent = this.store.get(`intent:${change.zone}`);
        this.store.set(`intent:${change.zone}`, { ...intent, firstDue: change.firstDue });
      }
    });
    return { ok: true, plan: this.plan(), changes: proposal.changes };
  }

  /** POST /api/plan — saves night settings without review. */
  settings(patch) {
    const next = { ...this.plan().settings };
    for (const [k, v] of Object.entries(patch)) {
      if (!Object.hasOwn(SETTING_LIMITS, k)) throw new AppError('Unknown plan setting', 400);
      next[k] = number(v, ...SETTING_LIMITS[k], true);
    }
    this.store.set('planSettings', next);
    return { ok: true, settings: next };
  }
}
