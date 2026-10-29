// Reads the controller programs Tucor pushes after controller selection. Pure:
// the server keeps the raw packets as a restorable backup, and both the server
// and the web app use this normalized view. Field meanings come from Tucor's
// program editor (research/protocol.md, “Programs”).

/** Packet fields that describe the moment, not the program. */
const VOLATILE = [
  'runningStatus',
  'runningEntries',
  'nextRun',
  'today',
  'prgTopBtnName',
  'runnable',
  'unixtime',
  // The day letters start on the day of the read.
  'allDaysArranged',
];

const PERIODS = { 0: '14 days', 1: 'Odd', 2: 'Even' };
const TYPES = { 0: 'budget', 4: 'weather' };

/** Tucor's 14-day mask, rotated so equal schedules compare equal. */
function canonicalMask(mask, arranged) {
  let text = String(mask ?? '');
  if (text.length !== 14) return text;
  // The mask starts on the day of the read, so start it on a Sunday instead.
  const sunday = String(arranged ?? '').indexOf('S');
  if (sunday > 0) text = text.slice(sunday) + text.slice(0, sunday);
  // Which week comes first still isn't known: the same program has arrived
  // with its two weeks swapped.
  const swapped = text.slice(7) + text.slice(0, 7);
  return swapped < text ? swapped : text;
}

/**
 * The parts of each program a person set. Comparing these finds real changes
 * and ignores running state and the moving 14-day window.
 * @param {any[]} list Raw `Programs` packet data.
 */
export function programDefinition(list = []) {
  return list.map(p => {
    const definition = { ...p, fullDaySchedule: canonicalMask(p.fullDaySchedule, p.allDaysArranged) };
    for (const field of VOLATILE) delete definition[field];
    return definition;
  });
}

/**
 * @typedef {{ minute: number, cycles: number, finish: number | null }} ProgramStart
 * @typedef {{ zone: string, seconds: number }} ProgramStep
 * @typedef {{
 *   id: string, name: string, active: boolean, budget: number, type: string,
 *   period: string, days: boolean[], starts: ProgramStart[], steps: ProgramStep[],
 *   seconds: number, adjustedSeconds: number, firstDay: number | null
 * }} Program `days` start on the day of the read; `firstDay` is that weekday, 0 for Sunday.
 */

/** @returns {Program} */
export function readProgram(p) {
  const budget = Number(p.waterBudget);
  const steps = (p.steps ?? [])
    .map(s => ({ zone: String(s.decoders?.[0] ?? s.runSeq), seconds: Number(s.runtime) }))
    .filter(s => Number.isFinite(s.seconds) && s.seconds > 0);
  const seconds = steps.reduce((sum, s) => sum + s.seconds, 0);
  // Tucor's day letters, Sunday first; the list starts on the day of the read.
  const first = 'SMtWTFs'.indexOf(String(p.allDaysArranged ?? '').charAt(0) || '?');
  return {
    id: String(p.ID),
    name: String(p.name ?? '').trim() || `Program ${p.ID}`,
    active: String(p.status) === '1',
    budget: Number.isFinite(budget) ? budget : 100,
    type: TYPES[p.irrigationType] ?? `type ${p.irrigationType}`,
    period: PERIODS[p.period] ?? `period ${p.period}`,
    days: [...String(p.fullDaySchedule ?? '')].map(c => c !== '-'),
    starts: (p.starts ?? [])
      .map(s => ({ minute: Number(s.starttime), cycles: Number(s.cycles) || 1, finish: Number(s.endtime) }))
      .filter(s => Number.isFinite(s.minute) && s.minute >= 0)
      .map(s => ({ ...s, finish: Number.isFinite(s.finish) && s.finish >= 0 ? s.finish : null })),
    steps,
    seconds,
    adjustedSeconds: Math.round((seconds * (Number.isFinite(budget) ? budget : 100)) / 100),
    firstDay: first < 0 ? null : first,
  };
}

/**
 * The limits that matter for writing programs, from Tucor's `Capabilities`.
 * @param {any} c
 */
export function readCapabilities(c) {
  if (!c) return null;
  return {
    maxStarts: Number(c.startTimes?.maxStarts) || null,
    maxStationsPerStep: Number(c.steps?.maxStationsPerStep) || null,
    // Without step deletion, the editor removes a station by zeroing its runtime.
    deleteStep: c.steps?.deleteStep !== false,
    nameLength: c.name?.enable ? Number(c.name.maxLength) || null : null,
    budget: c.wb ? { minimum: Number(c.wb.minimum), maximum: Number(c.wb.maximum) } : null,
    allowPeriodChange: c.allowPeriodChange !== false,
    periods: (c.periods ?? []).map(p => ({ value: Number(p.value), label: p.label, editable: Boolean(p.editable) })),
    types: (c.programTypes ?? []).map(t => ({ value: Number(t.value), label: t.label })),
    methods: c.programMethod ?? [],
  };
}
