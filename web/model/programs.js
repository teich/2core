// Text for the controller's current programs (GET /api/programs). Pure.
import { formatDuration } from '../../lib/planner.mjs';
import { WD, clockAt } from './plan.js';

/** The weekdays watered in seven days that start on weekday `from`, Sunday first. */
const weekDays = (days, from) => WD.filter((_, weekday) => days[(weekday - from + 7) % 7]).join(', ');

/**
 * Which days a program waters. Tucor's 14-day mask starts on the day of the
 * read (`firstDay`), so its first week is the coming seven days.
 * @param {{ period: string, days: boolean[], firstDay?: number | null }} p
 */
export function programDays(p) {
  if (p.period === 'Odd') return 'Odd days';
  if (p.period === 'Even') return 'Even days';
  const from = p.firstDay ?? 0;
  const first = weekDays(p.days.slice(0, 7), from),
    second = weekDays(p.days.slice(7, 14), from);
  if (!first && !second) return 'No watering days';
  if (first === second) return `Every week: ${first}`;
  return `Alternating weeks: ${first || 'none'} / ${second || 'none'}`;
}

/**
 * @param {import('../../lib/programs.mjs').Program} p
 * @param {Record<string, string>} names Zone names by id.
 */
export function programRow(p, names) {
  const starts = p.starts.map(s => clockAt(s.minute) + (s.cycles > 1 ? ` ×${s.cycles}` : ''));
  const notes = [
    p.active ? null : 'Off',
    p.budget === 100 ? null : `${p.budget}% water budget`,
    p.type === 'budget' ? null : `${p.type[0].toUpperCase()}${p.type.slice(1)} program`,
  ].filter(Boolean);
  return {
    id: p.id,
    name: p.name,
    active: p.active,
    when: starts.length ? `${starts.join(', ')} · ${formatDuration(p.adjustedSeconds)}` : 'No start time',
    days: programDays(p),
    steps: p.steps.map(s => ({ name: names[s.zone] ?? `Zone ${s.zone}`, duration: formatDuration(s.seconds) })),
    notes,
  };
}

/**
 * The summary line above the list.
 * @param {{ observedAt: string | null, programs: any[], backups: { original: { receivedAt: string } | null } }} result
 * @param {(iso: string) => string} ago
 * @param {(iso: string) => string} day
 */
export function programsSummary(result, ago, day) {
  if (!result.observedAt) return 'Not read yet. 2core reads programs the next time it connects to the controller.';
  const on = result.programs.filter(p => p.active).length;
  const original = result.backups.original?.receivedAt;
  return `${result.programs.length} programs · ${on} on · read ${ago(result.observedAt)}.${original ? ` A copy from ${day(original)} is kept for restoring.` : ''}`;
}

const JOBS = {
  '/api/programs/install': 'Install the plan on the controller',
  '/api/programs/restore-before-install': 'Put the programs back',
  '/api/programs/rename': 'Rename programs',
  '/api/programs/test-write': 'Program test write',
  '/api/programs/restore-test-slot': 'Restore the test program',
};
/** The label for a program job's operation, or null for other commands. */
export const programJobLabel = kind => JOBS[kind] ?? null;

/**
 * What a finished program job means, for the status banner. A job can finish
 * without its programs reaching the controller, so the outcome decides.
 * @param {{ kind: string, state: string, result?: any }} operation
 * @returns {{ text: string, failed: boolean }}
 */
export function programOutcome(operation) {
  const label = programJobLabel(operation.kind) ?? 'Program change';
  const r = operation.result ?? {};
  if (operation.state === 'failed')
    return { text: `${label}: ${r.error ?? 'not confirmed'}. Check the controller before trying again.`, failed: true };
  const problems = (r.problems ?? []).join(' ');
  const outcomes = {
    synced: { text: `${label}: done and synced to the controller.`, failed: false },
    'already synced': { text: `${label}: done; Tucor had already synced it.`, failed: false },
    'nothing to change': { text: `${label}: nothing needed changing.`, failed: false },
    'not synced': {
      text: `${label}: written to Tucor, but not synced to the controller. ${problems}`.trim(),
      failed: true,
    },
    'synced, not read back': {
      text: `${label}: synced, but Tucor didn’t send the programs back. Read them again to check.`,
      failed: true,
    },
  };
  return outcomes[r.outcome] ?? { text: `${label}: ${r.outcome ?? 'finished'}. ${problems}`.trim(), failed: !r.ok };
}

// A job's record names its kind; the outcome text is keyed by its route.
const RECORD_KINDS = {
  'install plan': '/api/programs/install',
  'restore before install': '/api/programs/restore-before-install',
  'rename programs': '/api/programs/rename',
  'test write': '/api/programs/test-write',
  'restore test slot': '/api/programs/restore-test-slot',
};
/**
 * A program job's record (GET /api/programs `tests`) as one sentence.
 * @param {{ kind: string, outcome: string, problems?: string[], error?: string }} record
 */
export function programRecordText(record) {
  // A record that ends in an error was refused or cut off; its outcome says which.
  const failed = Boolean(record.error) && ['not sent', 'unknown', 'sync unknown'].includes(record.outcome);
  const text = programOutcome({
    kind: RECORD_KINDS[record.kind] ?? '',
    state: failed ? 'failed' : 'succeeded',
    result: record,
  }).text;
  return failed && record.outcome !== 'not sent' ? `${text} The outcome is unknown.` : text;
}

/**
 * Why a program name can't be written, or null. Tucor takes plain characters
 * up to the controller's limit.
 * @param {string} name @param {number} [max]
 */
export function nameProblem(name, max = 12) {
  if (!name) return 'Give it a name.';
  if (name !== name.trim()) return 'No spaces at the start or end.';
  if (!/^[\x20-\x7e]+$/.test(name)) return 'Letters, numbers and plain symbols only.';
  if (name.length > max) return `${name.length} characters; the controller takes ${max}.`;
  return null;
}

/**
 * The programs an install review would change, with what changes.
 * @param {{ programs: { slot: number, name: string, use: string, changes: string[], messages: any[] }[] }} preview
 */
export const reviewRows = preview =>
  preview.programs
    .filter(p => p.messages.length)
    .map(p => ({ slot: p.slot, name: p.name, off: p.use === 'off', changes: p.changes }));

/**
 * Whether the sheet's program actions can run, and why not.
 * @param {{ writesEnabled?: boolean, observedAt: string | null }} result
 */
export function programWrites(result) {
  if (!result.writesEnabled)
    return {
      enabled: false,
      note: 'Program writes are off on the server. Set ALLOW_PROGRAM_WRITES=true to use these.',
    };
  if (!result.observedAt) return { enabled: false, note: 'Open the app once so 2core reads the programs first.' };
  return { enabled: true, note: 'Program writes are on. Keep Tucor’s own app closed while one runs.' };
}
