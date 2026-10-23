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
export const OPEN = [
  { category: 'route', data: '/programs' },
  { component: 'Programs', command: 'Created' },
  { component: 'Programs', command: 'Mounted' },
];
export const READBACK = [{ component: 'Programs', command: 'Mounted' }];
// Leaving the page the way the app does, back to the dashboard 2core reads.
export const CLOSE = [
  { component: 'Programs', command: 'Destroyed' },
  { category: 'route', data: '/home' },
  { component: 'Home', command: 'Created' },
  { component: 'Home', command: 'Mounted' },
];
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

/** Tucor's day letters for the fourteen days from `date`, as `allDaysArranged` lists them. */
export const lettersFor = date =>
  Array.from({ length: DAYS }, (_, i) => LETTERS[(fromKey(date).getDay() + i) % 7]).join('');

/** A `Weekdays` mask: each watering day's letter, `-` for the others, from `date`. */
export const weekdaysFor = (days, date) => {
  const letters = lettersFor(date);
  return days.map((on, i) => (on ? letters[i] : '-')).join('');
};

/**
 * @typedef {{
 *   active: boolean, type: number, period: number,
 *   weekdays: string | null, budget: number, booster: number | null,
 *   starts: { minute: number, cycles: number, endTime: number | null }[],
 *   steps: { zone: string, seconds: number }[],
 * }} SlotTarget What a program slot should hold. `weekdays` is null for a period
 *   whose days can't be edited, `booster` null to leave it as it is.
 */

/** A raw program as a target, for leaving it as it is or putting it back. */
export function currentTarget(raw) {
  const p = readProgram(raw);
  return {
    active: p.active,
    type: Number(raw.irrigationType),
    period: Number(raw.period),
    weekdays: Number(raw.period) === 0 ? String(raw.fullDaySchedule) : null,
    budget: p.budget,
    booster: Number(raw.booster) || 0,
    starts: p.starts.map(s => ({ minute: s.minute, cycles: s.cycles, endTime: s.finish })),
    steps: p.steps,
  };
}

/**
 * The target that restores a saved copy of a program. Its mask was read on
 * `readDate`, so it's moved on to the fourteen days from `today`.
 * @param {any} raw @param {string} readDate @param {string} today
 */
export function restoreTarget(raw, readDate, today) {
  const target = currentTarget(raw);
  if (target.weekdays === null) return target;
  const shift = Math.round((fromKey(today).getTime() - fromKey(readDate).getTime()) / 86400000);
  const saved = [...target.weekdays].map(ch => ch !== '-');
  return {
    ...target,
    weekdays: weekdaysFor(
      saved.map((_, i) => saved[(((i + shift) % DAYS) + DAYS) % DAYS]),
      today,
    ),
  };
}

/**
 * The editor's messages that take one slot from `raw` to `target`, and what
 * changes. Nothing is sent for a slot that already matches. A slot is switched
 * off first and, when the target is on, on last: a write that stops partway
 * leaves it off, so a half-edited program never waters.
 * @param {any} raw @param {SlotTarget} target @param {any} c Capabilities.
 */
export function writeSlot(raw, target, c) {
  const slot = Number(raw.ID),
    now = readProgram(raw),
    body = [],
    changes = [];
  if (Number(raw.irrigationType) !== target.type) {
    body.push(data(slot, 'IrrType', target.type));
    changes.push(`Type ${now.type} → ${target.type === 0 ? 'budget' : `type ${target.type}`}`);
  }
  if (Number(raw.period) !== target.period) {
    body.push(data(slot, 'Period', target.period));
    changes.push(`${now.period} → ${target.period === 0 ? '14-day calendar' : `period ${target.period}`}`);
  }
  if (target.weekdays !== null) {
    // The editor sends the period with every change of days.
    body.push({ ...data(slot, 'Period', target.period), Weekdays: target.weekdays });
    if (target.weekdays !== raw.fullDaySchedule) changes.push(`Days ${raw.fullDaySchedule} → ${target.weekdays}`);
  }
  if (now.budget !== target.budget) {
    body.push(data(slot, 'Budget', target.budget));
    changes.push(`Budget ${now.budget}% → ${target.budget}%`);
  }
  if (target.booster !== null && (Number(raw.booster) || 0) !== target.booster) {
    body.push(data(slot, 'Booster', target.booster));
    changes.push(`Booster ${Number(raw.booster) || 'none'} → ${target.booster || 'none'}`);
  }
  // The editor rewrites every start slot and clears the unused ones.
  for (let seq = 1; seq <= c.maxStarts; seq++) {
    const start = target.starts[seq - 1];
    body.push({
      Category: 'Irrigation',
      Type: 'IrrPgmStart',
      Oper: 'Upd',
      PgmId: slot,
      Seq: seq,
      ...(start
        ? { Time: start.minute, Cycles: start.cycles, EndTime: start.endTime ?? -1 }
        : { Time: -1, Cycles: null, EndTime: null }),
    });
  }
  const startText = starts =>
    starts.map(s => clock(s.minute) + (s.cycles > 1 ? ` ×${s.cycles}` : '')).join(', ') || 'none';
  if (startText(now.starts) !== startText(target.starts))
    changes.push(`Start ${startText(now.starts)} → ${startText(target.starts)}`);
  // Steps sit at their station number, so each step is addressed by station.
  const old = new Map(now.steps.map(s => [s.zone, s.seconds]));
  for (const s of target.steps) {
    if (old.get(s.zone) === s.seconds) continue;
    body.push({
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
    if (target.steps.some(s => s.zone === zone)) continue;
    // As the editor does with one station per step: always Upd, 0 to remove.
    body.push({ Category: 'Irrigation', Type: 'IrrPgmCont', Oper: 'Upd', PgmId: slot, Seq: Number(zone), RunTime: 0 });
    changes.push(`Remove zone ${zone}`);
  }
  if (now.active !== target.active) changes.push(target.active ? 'Turn on' : 'Turn off');
  if (!changes.length) return { messages: [], changes };
  // Turning a slot off needs nothing else.
  if (!target.active && changes.length === 1) return { messages: [data(slot, 'Status', 0)], changes };
  const messages = [...(now.active ? [data(slot, 'Status', 0)] : []), ...body];
  if (target.active) messages.push(data(slot, 'Status', 1));
  return { messages, changes };
}

/**
 * Where a program read back from Tucor differs from its target. The mask is
 * only comparable when the read was made on the day the target was built for.
 * @param {any} raw @param {SlotTarget} target
 */
export function readbackProblems(raw, target) {
  if (!raw) return ['The program is missing from the readback.'];
  const now = currentTarget(raw),
    problems = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (now.active !== target.active) problems.push(`Status is ${now.active ? 'on' : 'off'}`);
  if (now.type !== target.type) problems.push(`Type is ${now.type}`);
  if (now.period !== target.period) problems.push(`Period is ${now.period}`);
  if (target.weekdays !== null && now.weekdays !== target.weekdays) {
    const swapped = target.weekdays.slice(7) + target.weekdays.slice(0, 7);
    problems.push(`Days are ${now.weekdays}${now.weekdays === swapped ? ' (the two weeks swapped)' : ''}`);
  }
  if (now.budget !== target.budget) problems.push(`Budget is ${now.budget}%`);
  if (target.booster !== null && now.booster !== target.booster) problems.push(`Booster is ${now.booster}`);
  const starts = s => s.map(x => [x.minute, x.cycles]);
  if (!same(starts(now.starts), starts(target.starts)))
    problems.push(`Starts are ${JSON.stringify(starts(now.starts))}`);
  const steps = s => [...s].sort((a, b) => Number(a.zone) - Number(b.zone)).map(x => [x.zone, x.seconds]);
  if (!same(steps(now.steps), steps(target.steps))) problems.push(`Steps are ${JSON.stringify(steps(now.steps))}`);
  return problems;
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
  const expected = lettersFor(today);
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
    if (!next) {
      const { messages, changes } = writeSlot(raw, { ...currentTarget(raw), active: false }, c);
      if (messages.length) result.summary.slotsOff++;
      result.programs.push({ slot, name: now.name, use: 'off', changes, messages });
      continue;
    }
    const days = Array.from({ length: DAYS }, (_, i) => next.calendarMask[(((shift + i) % DAYS) + DAYS) % DAYS]);
    const { messages, changes } = writeSlot(
      raw,
      {
        active: true,
        type: 0,
        period: 0,
        weekdays: weekdaysFor(days, today),
        budget: 100,
        booster: null,
        starts: [
          { minute: next.clockMinute, cycles: 1, endTime: Math.floor((next.clockMinute * 60 + next.seconds) / 60) },
        ],
        steps: next.steps,
      },
      c,
    );
    const kept = next.steps.filter(s => now.steps.some(o => o.zone === s.zone)).length;
    result.summary.programs++;
    // A slot that already matches is left alone.
    if (!changes.length) result.summary.unchanged++;
    result.programs.push({
      slot,
      name: now.name,
      compiled: next.slot,
      use: changes.length ? 'plan' : 'keep',
      keptZones: kept,
      changes,
      messages,
    });
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
