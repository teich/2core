// Human-facing diagnostics and verified repairs around the dry-run compiler.
// This module cannot save intentions or operate the controller.
import { compilePrograms } from './program-compiler.mjs';
import { addDays, adjustedSeconds, dateKey, fromKey, gaps, nextDueDate } from './planner.mjs';
const clone = x => structuredClone(x);
const clock = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function explanation(p) {
  return { ...reasonFor(p), zoneIds: [...new Set(p.issues.map(i => i.zone).filter(id => id != null))] };
}
function reasonFor(p) {
  const codes = new Set(p.issues.map(i => i.code));
  if (codes.has('program-limit')) return { reason: 'patterns', message: 'We couldn’t fit these watering patterns into the controller’s repeating schedules. Sharing watering dates may help; a wider night alone will not fix this arrangement.', detail: p.issues.map(i => i.message).join(' ') };
  if (codes.has('cadence')) return { reason: 'cadence', message: 'This frequency cannot repeat exactly on the controller’s two-week calendar.', detail: p.issues.map(i => i.message).join(' ') };
  if (codes.has('runtime-precision')) return { reason: 'precision', message: 'The controller cannot express this adjusted run length exactly. No watering amounts have been rounded.', detail: p.issues.map(i => i.message).join(' ') };
  if (codes.has('incomplete-intent')) return { reason: 'incomplete', message: 'Some zones still need a run length or frequency.', detail: p.issues.map(i => i.message).join(' ') };
  if (codes.has('transient-dates')) return { reason: 'transition', message: 'These first watering dates need a transition before a repeating schedule can start.', detail: p.issues.map(i => i.message).join(' ') };
  const capacity = (p.horizon.hardDeadline - p.horizon.earliestStart) * 60;
  if (p.summary.peakNightSeconds > capacity * p.settings.lanes || p.summary.longestRunSeconds > capacity) return { reason: 'time', message: 'The requested watering exceeds the available overnight time. An earlier start, later deadline, or more overlap may help.', detail: p.issues.map(i => i.message).join(' ') };
  return { reason: 'search', message: 'We couldn’t find an overnight arrangement. More overnight time or two zones at once may help. This is not proof that the controller cannot do it.', detail: p.issues.map(i => i.message).join(' ') };
}

export function assessPlan({ zones, before, after, seasonalZoneIds = [], start, sunriseAt }) {
  const scenarios = [{ id: 'current', label: 'This plan', overrides: {} }];
  if (seasonalZoneIds.length) {
    scenarios.push({ id: 'seasonal-off', label: 'Seasonal zones off', overrides: Object.fromEntries(seasonalZoneIds.map(id => [id, false])) },
      { id: 'seasonal-on', label: 'Seasonal zones on', overrides: Object.fromEntries(seasonalZoneIds.map(id => [id, true])) });
  }
  const reports = scenarios.map(s => {
    const input = { zones, start, sunriseAt, enabledOverrides: s.overrides };
    const previous = compilePrograms({ ...input, ...before }), candidate = compilePrograms({ ...input, ...after });
    if (candidate.status !== 'candidate') return { id: s.id, label: s.label, status: 'needs-adjustment', ...explanation(candidate), programs: candidate.summary.programs };
    const overlap = candidate.summary.parallelSeconds;
    const comparable = previous.status === 'candidate';
    const additionalOverlapSeconds = comparable ? Math.max(0, overlap - previous.summary.parallelSeconds) : 0;
    const newParallelSeconds = comparable ? 0 : overlap;
    const affectedNights = candidate.nights.filter((n, d) => n.parallelSeconds > (previous.nights[d]?.parallelSeconds ?? 0)).length;
    const laterFinishNights = candidate.nights.filter((n, d) => n.finish != null && previous.nights[d]?.finish != null && n.finish > previous.nights[d].finish).length;
    const afterPreferredNights = candidate.nights.filter(n => n.finish > candidate.horizon.preferredFinish).length;
    return { id: s.id, label: s.label, status: additionalOverlapSeconds || newParallelSeconds || laterFinishNights || afterPreferredNights ? 'consequence' : 'fits',
      programs: candidate.summary.programs, additionalOverlapSeconds, newParallelSeconds, comparable, affectedNights, laterFinishNights, afterPreferredNights,
      parallelSeconds: overlap, maxConcurrent: candidate.summary.maxConcurrent, sunriseKnown: candidate.horizon.sunriseKnown,
      latestFinish: Math.max(0, ...candidate.nights.map(n => n.finish ?? 0)), detail: `${candidate.summary.programs}/10 repeating programs. ${candidate.summary.minimumOverlapProven ? 'Minimum overlap for this window.' : 'Feasible candidate; overlap may be reducible.'}` };
  });
  return { status: reports.some(r => r.status === 'needs-adjustment') ? 'needs-adjustment' : reports.some(r => r.status === 'consequence') ? 'consequence' : 'fits', scenarios: reports };
}

export function verifiedAlternatives({ zones, before, after, seasonalZoneIds, start, sunriseAt, editedZoneIds = [], report }) {
  if (report.status !== 'needs-adjustment') return [];
  let attempts = 0;
  const alternatives = [], reasons = new Set(report.scenarios.filter(s => s.status === 'needs-adjustment').map(s => s.reason));
  const check = (plan, adjustments, description) => {
    if (++attempts > 24) return;
    const assessment = assessPlan({ zones, before, after: plan, seasonalZoneIds, start, sunriseAt });
    if (assessment.status !== 'needs-adjustment') alternatives.push({ id: String(alternatives.length), adjustments, description, assessment });
  };
  // Only shift edited zones; never repair a draft by quietly moving another zone.
  if (reasons.has('patterns') || (reasons.has('search') || reasons.has('time'))) for (const id of editedZoneIds.slice(0, 3)) {
    const intent = after.intents[id];
    if (!intent?.cadence || !intent.firstDue) continue;
    const oldDate = nextDueDate(intent, start), maxShift = Math.min(13, Math.max(...gaps(intent.cadence)) - 1);
    for (let distance = 1; distance <= maxShift && alternatives.length < 3; distance++) for (const shift of [distance, -distance]) {
      const firstDue = dateKey(addDays(fromKey(intent.firstDue), shift));
      const changed = { ...intent, firstDue }, next = nextDueDate(changed, start);
      const expected = dateKey(addDays(fromKey(oldDate), shift));
      if (next !== expected || next < dateKey(start)) continue;
      const plan = clone(after); plan.intents[id] = changed;
      const name = zones.find(z => z.id === id)?.name ?? `Zone ${id}`;
      check(plan, { intents: { [id]: { firstDue } } }, `${name}: next watering ${oldDate} → ${next} (${distance} day${distance > 1 ? 's' : ''} ${shift > 0 ? 'later; a longer wait' : 'earlier; a shorter gap'}). Later dates shift with it; requested duration and frequency stay the same.`);
      if (alternatives.length >= 3) break;
    }
  }
  // These repairs only address timing, never the number of calendar groups.
  if ((reasons.has('search') || reasons.has('time')) && !reasons.has('patterns') && alternatives.length < 3) {
    if (after.settings.lanes === 1) {
      const plan = clone(after); plan.settings.lanes = 2;
      check(plan, { settings: { lanes: 2 } }, 'Allow up to two zones at once. Watering amounts and dates stay the same.');
    }
    for (const field of ['earliestStart', 'hardDeadline']) {
      if (alternatives.length >= 3) break;
      for (const delta of [30, 60, 120]) {
        const value = after.settings[field] + (field === 'earliestStart' ? -delta : delta);
        if (field === 'earliestStart' ? value < 1080 : value > 720) continue;
        const plan = clone(after); plan.settings[field] = value;
        const count = alternatives.length;
        check(plan, { settings: { [field]: value } }, `${field === 'earliestStart' ? 'Allow watering to start at' : 'Allow watering to finish as late as'} ${clock(value)}. Watering amounts and dates stay the same.`);
        if (alternatives.length > count) break;
      }
    }
  }
  // Unsupported frequencies are offered only as explicit, quantified changes.
  if (reasons.has('cadence') && alternatives.length < 3) for (const id of editedZoneIds.slice(0, 1)) {
    const intent = after.intents[id];
    if (!intent?.cadence) continue;
    const oldWeekly = 7 * gaps(intent.cadence).length / gaps(intent.cadence).reduce((a, b) => a + b, 0);
    for (const cadence of [{ perWeek: 2 }, { perWeek: 3 }, { every: 2 }, { every: 7 }].sort((a, b) => Math.abs((a.perWeek ?? 7 / a.every) - oldWeekly) - Math.abs((b.perWeek ?? 7 / b.every) - oldWeekly))) {
      const plan = clone(after), firstDue = nextDueDate(intent, start), weekly = cadence.perWeek ?? 7 / cadence.every;
      plan.intents[id] = { ...intent, cadence, firstDue };
      const seconds = adjustedSeconds(intent);
      check(plan, { intents: { [id]: { cadence, firstDue } } }, `${zones.find(z => z.id === id)?.name ?? id}: change frequency from about ${oldWeekly.toFixed(2)} to ${weekly} times/week (${Math.round(oldWeekly * seconds / 60)} → ${Math.round(weekly * seconds / 60)} watering minutes/week). Next watering stays ${firstDue}.`);
      if (alternatives.length >= 3) break;
    }
  }
  return alternatives.slice(0, 3);
}
