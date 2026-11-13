// What publishing the saved plan to the controller would change. Pure.
// The saved plan collects edits; publishing installs it into the controller's
// programs. Only what reaches the programs counts: complete intentions and
// the night settings.
import { DEFAULT_INTENT, DEFAULT_SETTINGS, intentProblem } from './planner.mjs';

const INTENT_FIELDS = ['enabled', 'seconds', 'cadence', 'seasonalPercent', 'firstDue'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The part of a plan that the controller's programs follow: night settings
 * and complete intentions, in zone order.
 * @param {{ settings?: any, intents?: Record<string, any> }} plan
 */
export function wateringPlan(plan) {
  const intents = Object.entries(plan?.intents ?? {})
    .map(([id, intent]) => [id, { ...DEFAULT_INTENT, ...intent }])
    .filter(([, intent]) => !intentProblem({ ...intent, enabled: true }))
    .sort(([a], [b]) => Number(a) - Number(b) || (a < b ? -1 : 1))
    .map(([id, intent]) => [id, Object.fromEntries(INTENT_FIELDS.map(k => [k, intent[k]]))]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...plan?.settings },
    intents: Object.fromEntries(intents),
  };
}

/**
 * Each change from the published plan to the saved one.
 * Zones: `{ zone, added?, removed?, fields: [{ field, before, after }] }`.
 * Settings: `[{ field, before, after }]`.
 * @param {any} published The plan as last published.
 * @param {any} saved The saved plan.
 */
export function planChanges(published, saved) {
  const before = wateringPlan(published),
    after = wateringPlan(saved);
  const ids = [...new Set([...Object.keys(before.intents), ...Object.keys(after.intents)])].sort(
    (a, b) => Number(a) - Number(b),
  );
  const zones = [];
  for (const zone of ids) {
    const a = before.intents[zone],
      b = after.intents[zone];
    if (!a) zones.push({ zone, added: true, fields: [] });
    else if (!b) zones.push({ zone, removed: true, fields: [] });
    else {
      const fields = INTENT_FIELDS.filter(f => !same(a[f], b[f])).map(field => ({
        field,
        before: a[field],
        after: b[field],
      }));
      if (fields.length) zones.push({ zone, fields });
    }
  }
  const settings = Object.keys(after.settings)
    .filter(f => !same(before.settings[f], after.settings[f]))
    .map(field => ({ field, before: before.settings[field], after: after.settings[field] }));
  return { zones, settings };
}

/** A night's runs as `{ zones, start, finish }`: zones in order, times in night minutes. */
function nightOf(runs) {
  if (!runs?.length) return { zones: [], start: null, finish: null };
  return {
    zones: [...new Set(runs.map(r => r.zone))].sort((a, b) => Number(a) - Number(b)),
    start: Math.min(...runs.map(r => r.from)),
    finish: Math.max(...runs.map(r => r.to)),
  };
}

/**
 * The next nights as the controller waters them now and as it would after
 * publishing, with minutes a week per zone.
 * @param {{ night: string, before: import('./night-checks.mjs').NightRun[], after: import('./night-checks.mjs').NightRun[] }[]} nights
 */
export function publishImpact(nights) {
  const minutes = { before: new Map(), after: new Map() };
  const rows = nights.map(({ night, before, after }) => {
    for (const r of before) minutes.before.set(r.zone, (minutes.before.get(r.zone) ?? 0) + (r.to - r.from));
    for (const r of after) minutes.after.set(r.zone, (minutes.after.get(r.zone) ?? 0) + (r.to - r.from));
    const a = nightOf(before),
      b = nightOf(after);
    return { night, before: a, after: b, changed: !same(a, b) };
  });
  const weeks = nights.length / 7 || 1;
  const zones = [...new Set([...minutes.before.keys(), ...minutes.after.keys()])]
    .sort((a, b) => Number(a) - Number(b))
    .map(zone => ({
      zone,
      before: Math.round((minutes.before.get(zone) ?? 0) / weeks),
      after: Math.round((minutes.after.get(zone) ?? 0) / weeks),
    }));
  return { nights: rows, zones };
}
