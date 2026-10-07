// Text for the controller's current programs (GET /api/programs). Pure.
import { formatDuration } from '../../lib/planner.mjs';
import { WD, clockAt } from './plan.js';

const weekDays = days => WD.filter((_, i) => days[i]).join(', ');

/**
 * Which days a program waters. Tucor's 14-day mask starts on a Sunday, but which
 * of its two weeks is this week isn't confirmed, so alternating weeks aren't
 * labelled this/next.
 * @param {{ period: string, days: boolean[] }} p
 */
export function programDays(p) {
  if (p.period === 'Odd') return 'Odd days';
  if (p.period === 'Even') return 'Even days';
  const first = weekDays(p.days.slice(0, 7)),
    second = weekDays(p.days.slice(7, 14));
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
