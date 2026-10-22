// Weekly watering per zone: the controller's programs against 2core's plan.
// Pure. Compares averages, not calendars: a zone watered 30 min every 2 days
// and one watered 35 min on alternating Mon/Thu and Sun/Wed/Sat weeks can be
// equal here while landing on different nights.

/** Waterings per week of one program start. Odd and even days average 3.5. */
export function programPerWeek(program) {
  if (program.period === 'Odd' || program.period === 'Even') return 3.5;
  return program.days.filter(Boolean).length / 2;
}

/** Waterings per week of a plan cadence: `{every: n}` days or `{perWeek: n}`. */
export function cadencePerWeek(cadence) {
  if (cadence?.every) return 7 / cadence.every;
  return cadence?.perWeek ?? 0;
}

/**
 * @param {{
 *   programs: import('./programs.mjs').Program[],
 *   intents: Record<string, any>,
 *   zones?: { id: string, name: string }[],
 * }} input `programs` from GET /api/programs, `intents` and `zones` from GET /api/state.
 */
export function compareWatering({ programs, intents, zones = [] }) {
  const names = Object.fromEntries(zones.map(z => [z.id, z.name]));
  /** @type {Map<string, any>} */
  const rows = new Map();
  const row = id => {
    if (!rows.has(id))
      rows.set(id, { id, name: names[id] ?? `Zone ${id}`, controller: { weekly: 0, runs: [] }, plan: null });
    return rows.get(id);
  };

  // Only programs that are on water anything. The budget scales every step.
  for (const p of programs.filter(p => p.active)) {
    const perWeek = programPerWeek(p) * p.starts.length;
    for (const step of p.steps) {
      const seconds = Math.round((step.seconds * p.budget) / 100);
      const r = row(step.zone);
      r.controller.runs.push({ program: p.name, seconds, perWeek });
      r.controller.weekly += seconds * perWeek;
    }
  }
  for (const [id, intent] of Object.entries(intents)) {
    if (!intent.enabled || !intent.seconds || !intent.cadence) continue;
    const seconds = Math.round((intent.seconds * (intent.seasonalPercent ?? 100)) / 100);
    const perWeek = cadencePerWeek(intent.cadence);
    row(id).plan = { seconds, perWeek, weekly: seconds * perWeek };
  }

  const list = [...rows.values()]
    .map(r => {
      const planned = r.plan?.weekly ?? 0;
      return { ...r, change: r.controller.weekly ? planned / r.controller.weekly - 1 : planned ? null : 0 };
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
  const controller = list.reduce((sum, r) => sum + r.controller.weekly, 0);
  const plan = list.reduce((sum, r) => sum + (r.plan?.weekly ?? 0), 0);
  return { zones: list, totals: { controller, plan, change: controller ? plan / controller - 1 : null } };
}
