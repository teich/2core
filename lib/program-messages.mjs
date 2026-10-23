// Dry run: turns a compiled candidate into the `Irrigation` messages Tucor's
// program editor sends (research/protocol.md, “Writing”, read from the editor's
// source). Pure; nothing here sends, and no write has been tested yet.
import { fromKey } from './planner.mjs';
import { readProgram } from './programs.mjs';

const DAYS = 14;
// Tucor's day letters, Sunday first, as `allDaysArranged` uses them.
const LETTERS = 'SMtWTFs';
// What the editor sends when it opens; Programs/Mounted also asks Tucor to
// send the program list again, which is how the editor reads its edits back.
const OPEN = [
  { category: 'route', data: '/programs' },
  { component: 'Programs', command: 'Created' },
  { component: 'Programs', command: 'Mounted' },
];
const READBACK = [{ component: 'Programs', command: 'Mounted' }];
const ASSUMPTIONS = [
  'Weekdays is written in the order and letters Tucor reports: fourteen days from the day of the write, as allDaysArranged lists them. A supervised write must confirm this.',
  'The day letters repeat weekly, so they can’t show which week Tucor counts as first. Packets have arrived with the weeks swapped; the readback must confirm the dates.',
  'No sync is sent: Tucor’s editor doesn’t sync after program edits, and a sync can take the controller’s values over the app’s. Whether edits reach the controller on their own is for the supervised test to show.',
  'Programs count as installed only once a readback and the controller both match.',
];

const data = (slot, field, value) => ({
  Category: 'Irrigation',
  Type: 'IrrPgmData',
  Oper: 'Upd',
  Seq: slot,
  [field]: value,
});
const clock = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const span = s => (s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`);

/**
 * Gives each compiled program the slot that already holds most of its zones,
 * so fewer steps change and slot names stay closer to their contents. Exact
 * search over slot subsets (at most ten); ties keep the compiler's order.
 * @param {{ steps: { zone: string }[] }[]} programs
 * @param {import('./programs.mjs').Program[]} existing One per slot, in slot order.
 * @returns {number[]} The index into `existing` for each program.
 */
export function assignSlots(programs, existing) {
  const zones = existing.map(p => new Set(p.steps.map(s => s.zone)));
  const score = programs.map(p => zones.map(set => p.steps.filter(s => set.has(s.zone)).length));
  /** @type {Map<number, { total: number, picks: number[] }>[]} */
  const memo = programs.map(() => new Map());
  const best = (i, used) => {
    if (i === programs.length) return { total: 0, picks: [] };
    const known = memo[i].get(used);
    if (known) return known;
    let found = { total: -1, picks: /** @type {number[]} */ ([]) };
    for (let j = 0; j < existing.length; j++) {
      if (used & (1 << j)) continue;
      const rest = best(i + 1, used | (1 << j));
      if (rest.total + score[i][j] > found.total)
        found = { total: rest.total + score[i][j], picks: [j, ...rest.picks] };
    }
    memo[i].set(used, found);
    return found;
  };
  return best(0, 0).picks;
}

/**
 * @param {{
 *   candidate: any,
 *   current: any[],
 *   capabilities: ReturnType<typeof import('./programs.mjs').readCapabilities>,
 *   today: string,
 *   readDate?: string,
 * }} input `current` is the raw `Programs` list from the latest read, made on
 *   `readDate`; `today` is the controller's local date of the write (YYYY-MM-DD).
 */
export function programMessages({ candidate, current = [], capabilities, today, readDate = today }) {
  const issues = [],
    warnings = [];
  const result = {
    dryRun: true,
    status: 'blocked',
    writeDate: today,
    issues,
    warnings,
    assumptions: ASSUMPTIONS,
    programs: [],
    open: OPEN,
    readback: READBACK,
    summary: { programs: 0, unchanged: 0, slotsOff: 0, messages: 0 },
  };
  if (candidate?.status !== 'candidate') {
    issues.push({
      code: 'no-candidate',
      message: 'The plan didn’t compile into programs, so there’s nothing to write.',
    });
    return result;
  }
  if (!capabilities) {
    issues.push({ code: 'capabilities', message: 'Tucor hasn’t sent the controller’s program capabilities yet.' });
    return result;
  }
  const c = capabilities;
  if (!c.methods.includes('Sequential'))
    issues.push({ code: 'method', message: 'The controller doesn’t report sequential programs.' });
  if (!c.types.some(t => t.value === 0))
    issues.push({ code: 'type', message: 'The controller doesn’t offer water-budget programs.' });
  if (!c.allowPeriodChange || !c.periods.some(p => p.value === 0 && p.editable))
    issues.push({ code: 'period', message: 'The controller doesn’t allow an editable 14-day calendar.' });
  if (c.budget && (100 < c.budget.minimum || 100 > c.budget.maximum))
    issues.push({ code: 'budget', message: `A 100% budget is outside ${c.budget.minimum}–${c.budget.maximum}%.` });
  if (c.maxStationsPerStep !== 1)
    issues.push({
      code: 'multi-station-steps',
      message: 'This controller groups stations into steps (IrrPgmStep), which isn’t translated.',
    });
  if (!(c.maxStarts >= 1)) issues.push({ code: 'starts', message: 'The controller reports no start times.' });

  const slots = current.map(p => Number(p.ID)).sort((a, b) => a - b);
  if (candidate.programs.length > slots.length)
    issues.push({
      code: 'slots',
      message: `The plan needs ${candidate.programs.length} programs; the controller has ${slots.length}.`,
    });

  // Calendar masks are indexed from the compiler's anchor; Tucor's run from the write date.
  const shift = Math.round((fromKey(today).getTime() - fromKey(candidate.calendarAnchor).getTime()) / 86400000);
  const arranged = String(current[0]?.allDaysArranged ?? '');
  const expected = Array.from({ length: DAYS }, (_, i) => LETTERS[(fromKey(today).getDay() + i) % 7]).join('');
  // Masks are compared with what the controller has, which is only valid for a read made today.
  if (arranged !== expected || readDate !== today)
    issues.push({
      code: 'calendar-alignment',
      message: `Tucor’s calendar reads ${arranged || 'nothing'}, not the ${expected} expected for ${today}. Read the programs again on the day of the write.`,
    });

  for (const p of candidate.programs) {
    if (!Number.isInteger(p.clockMinute) || p.clockMinute < 0 || p.clockMinute >= 1440)
      issues.push({ code: 'start-time', slot: p.slot, message: `Program ${p.slot} doesn’t start on a whole minute.` });
    for (const s of p.steps) {
      if (!/^\d+$/.test(s.zone))
        issues.push({ code: 'station', zone: s.zone, message: `Zone ${s.zone} isn’t a station number.` });
      if (!Number.isInteger(s.seconds) || s.seconds <= 0)
        issues.push({ code: 'runtime', zone: s.zone, message: `${s.name}: ${s.seconds} seconds can’t be written.` });
    }
  }
  if (issues.length) return result;

  const bySlot = assignSlots(
    candidate.programs,
    slots.map(slot => readProgram(current.find(p => Number(p.ID) === slot))),
  ).reduce((map, s, i) => map.set(slots[s], candidate.programs[i]), new Map());
  for (const slot of slots) {
    const raw = current.find(p => Number(p.ID) === slot),
      now = readProgram(raw),
      next = bySlot.get(slot);
    const messages = [],
      changes = [];
    if (!next) {
      if (now.active) {
        messages.push(data(slot, 'Status', 0));
        changes.push('Turn off');
        result.summary.slotsOff++;
      }
      result.programs.push({ slot, name: now.name, use: 'off', changes, messages });
      continue;
    }
    if (now.type !== 'budget') {
      messages.push(data(slot, 'IrrType', 0));
      changes.push(`Type ${now.type} → budget`);
    }
    if (now.period !== '14 days') {
      messages.push(data(slot, 'Period', 0));
      changes.push(`${now.period} days → 14-day calendar`);
    }
    const days = Array.from({ length: DAYS }, (_, i) => next.calendarMask[(((shift + i) % DAYS) + DAYS) % DAYS]);
    const weekdays = days.map((on, i) => (on ? expected[i] : '-')).join('');
    // The editor sends the period with every change of days.
    messages.push({ ...data(slot, 'Period', 0), Weekdays: weekdays });
    if (weekdays !== raw.fullDaySchedule) changes.push(`Days ${raw.fullDaySchedule} → ${weekdays}`);
    if (now.budget !== 100) {
      messages.push(data(slot, 'Budget', 100));
      changes.push(`Budget ${now.budget}% → 100%`);
    }
    // The editor rewrites every start slot and clears the unused ones.
    for (let seq = 1; seq <= c.maxStarts; seq++)
      messages.push({
        Category: 'Irrigation',
        Type: 'IrrPgmStart',
        Oper: 'Upd',
        PgmId: slot,
        Seq: seq,
        ...(seq === 1
          ? { Time: next.clockMinute, Cycles: 1, EndTime: Math.floor((next.clockMinute * 60 + next.seconds) / 60) }
          : { Time: -1, Cycles: null, EndTime: null }),
      });
    const before = now.starts.map(s => clock(s.minute) + (s.cycles > 1 ? ` ×${s.cycles}` : '')).join(', ') || 'none';
    if (before !== clock(next.clockMinute)) changes.push(`Start ${before} → ${clock(next.clockMinute)}`);
    // Steps sit at their station number, so each step is addressed by station.
    const old = new Map(now.steps.map(s => [s.zone, s.seconds]));
    for (const s of next.steps) {
      if (old.get(s.zone) === s.seconds) continue;
      messages.push({
        Category: 'Irrigation',
        Type: 'IrrPgmCont',
        Oper: 'Upd',
        PgmId: slot,
        Seq: Number(s.zone),
        RunTime: s.seconds,
      });
      changes.push(
        old.has(s.zone)
          ? `Zone ${s.zone} ${span(old.get(s.zone))} → ${span(s.seconds)}`
          : `Add zone ${s.zone} · ${span(s.seconds)}`,
      );
    }
    for (const zone of old.keys()) {
      if (next.steps.some(s => s.zone === zone)) continue;
      messages.push({
        Category: 'Irrigation',
        Type: 'IrrPgmCont',
        // As the editor does with one station per step: always Upd, 0 to remove.
        Oper: 'Upd',
        PgmId: slot,
        Seq: Number(zone),
        RunTime: 0,
      });
      changes.push(`Remove zone ${zone}`);
    }
    if (!now.active) changes.push('Turn on');
    const kept = next.steps.filter(s => old.has(s.zone)).length;
    const entry = { slot, name: now.name, compiled: next.slot, use: 'plan', keptZones: kept, changes, messages };
    result.summary.programs++;
    // A slot that already matches is left alone.
    if (!changes.length) {
      result.programs.push({ ...entry, use: 'keep', messages: [] });
      result.summary.unchanged++;
      continue;
    }
    // Off first and on last: a write that stops partway leaves the slot off,
    // so a half-edited program never waters.
    if (now.active) messages.unshift(data(slot, 'Status', 0));
    messages.push(data(slot, 'Status', 1));
    result.programs.push(entry);
  }
  // No message sets a name. A slot that keeps fewer than half its new zones
  // probably keeps a name that no longer describes it.
  const stale = result.programs.filter(p => p.use === 'plan' && p.keptZones * 2 < bySlot.get(p.slot).steps.length);
  if (stale.length)
    warnings.push({
      code: 'names',
      message: `Program names can’t be written, and these slots now hold mostly other zones: ${stale.map(p => p.name).join(', ')}.`,
    });
  result.summary.messages = result.programs.reduce((n, p) => n + p.messages.length, 0) + OPEN.length + READBACK.length;
  result.status = 'ready';
  return result;
}
