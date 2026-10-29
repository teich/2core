// What a night should water, and what 2core's checks of it found. Pure.
// Tucor keeps no record of what ran (research/protocol.md, “Runtime history
// probe”), so a night is judged from two short sessions: one in the evening,
// to see whether the controller can run it, and one during a planned zone, to
// see it running (research/scheduling-plan.md, “Step 5: noticing a missed
// night”). Times are minutes after the midnight that starts the night's
// evening, as in planner.mjs, so 1:30am the next morning is 1530.
import { addDays, dateKey, fromKey } from './planner.mjs';

const DAYS = 14;
// Program starts before noon belong to the night that began the evening before.
const NOON = 12 * 60;
// The evening check runs this long before the first start, or at EVENING_DEFAULT on a night with nothing.
export const EVENING_LEAD = 60;
export const EVENING_DEFAULT = 21 * 60;
// A spot check needs a zone this long, checked at its middle, so a few minutes of
// clock difference between 2core and the controller can't make it miss.
export const SPOT_MINIMUM = 16;
// How late a spot check may still run.
export const SPOT_GRACE = 5;
const between = (a, b) => Math.round((fromKey(b).getTime() - fromKey(a).getTime()) / 864e5);

/**
 * @typedef {{ slot: number, program: string, zone: string, from: number, to: number, uncertain?: boolean }} NightRun
 * `uncertain` when the program cycles and soaks, so its timeline isn't simply step after step.
 */

/**
 * The runs of one night from a list of programs and a rule for which calendar
 * days each program runs.
 * @param {{ slot: number, name: string, starts: { minute: number, cycles: number }[], steps: { zone: string, seconds: number }[], budget: number, runsOn: (date: string) => boolean }[]} programs
 * @param {string} evening YYYY-MM-DD
 * @returns {NightRun[]}
 */
function runsFor(programs, evening) {
  const next = dateKey(addDays(fromKey(evening), 1));
  const runs = [];
  for (const p of programs) {
    for (const start of p.starts) {
      const day = start.minute >= NOON ? evening : next;
      if (!p.runsOn(day)) continue;
      let t = start.minute + (day === next ? 1440 : 0);
      for (const step of p.steps) {
        const minutes = (step.seconds * p.budget) / 100 / 60;
        if (!(minutes > 0)) continue;
        runs.push({
          slot: p.slot,
          program: p.name,
          zone: step.zone,
          from: t,
          to: t + minutes,
          ...(start.cycles > 1 ? { uncertain: true } : {}),
        });
        t += minutes;
      }
    }
  }
  return runs.sort((a, b) => a.from - b.from || a.slot - b.slot);
}

/**
 * What the controller's programs water on one night.
 * @param {import('./programs.mjs').Program[]} programs As read on `readDate`.
 * @param {string} readDate YYYY-MM-DD: the programs' 14 days start on this day.
 * @param {string} evening YYYY-MM-DD
 */
export function controllerNight(programs, readDate, evening) {
  return runsFor(
    programs
      .filter(p => p.active)
      .map(p => ({
        slot: Number(p.id),
        name: p.name,
        starts: p.starts,
        steps: p.steps,
        budget: p.budget,
        runsOn: date => {
          const dayOfMonth = fromKey(date).getDate();
          if (p.period === 'Odd') return dayOfMonth % 2 === 1;
          if (p.period === 'Even') return dayOfMonth % 2 === 0;
          const offset = between(readDate, date);
          return Boolean(p.days[((offset % DAYS) + DAYS) % DAYS]);
        },
      })),
    evening,
  );
}

/**
 * What the saved plan, compiled into programs, waters on one night.
 * @param {any} candidate From compilePrograms.
 * @param {string} evening
 */
export function planNight(candidate, evening) {
  if (candidate?.status !== 'candidate') return null;
  return runsFor(
    candidate.programs.map(p => ({
      slot: p.slot,
      name: `Program ${p.slot}`,
      starts: [{ minute: p.clockMinute, cycles: 1 }],
      steps: p.steps,
      budget: p.budgetPercent ?? 100,
      runsOn: date => {
        const offset = between(candidate.calendarAnchor, date);
        return Boolean(p.calendarMask[((offset % DAYS) + DAYS) % DAYS]);
      },
    })),
    evening,
  );
}

/** When the evening check runs, in night minutes. */
export const eveningAt = runs => (runs.length ? Math.min(...runs.map(r => r.from)) - EVENING_LEAD : EVENING_DEFAULT);

/**
 * The moment to look for a run in progress: the middle of the longest run that
 * is certain and long enough, or null.
 * @param {NightRun[]} runs
 * @returns {{ at: number, zone: string, program: string, expected: string[] } | null}
 */
export function spotTarget(runs) {
  const best = runs
    .filter(r => !r.uncertain && r.to - r.from >= SPOT_MINIMUM)
    .sort((a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from)[0];
  if (!best) return null;
  const at = Math.round((best.from + best.to) / 2);
  return {
    at,
    zone: best.zone,
    program: best.program,
    // Zones planned at that minute, in any lane.
    expected: [...new Set(runs.filter(r => r.from <= at && at < r.to).map(r => r.zone))],
  };
}

/** The set of zones a night waters, for comparing two versions of it. */
const zoneList = runs => [...new Set(runs.map(r => r.zone))].sort((a, b) => Number(a) - Number(b));

/**
 * What the evening session found. Each finding is `{ code, warn, message }`;
 * `warn` findings mean the night won't run as planned.
 * @param {{
 *   status: { controllerMode?: any, rainShutDown?: any },
 *   alarms?: any[],
 *   codes?: string[],
 *   runs: NightRun[],
 *   planRuns?: NightRun[] | null,
 *   sync: { state: string, message: string },
 *   firstStartInSeconds?: number | null,
 *   rainSource?: string | null,
 * }} input `firstStartInSeconds` is how far away the night's first start is.
 */
export function eveningFindings({
  status,
  alarms = [],
  codes = [],
  runs,
  planRuns = null,
  sync,
  firstStartInSeconds = null,
  rainSource = null,
}) {
  const findings = [];
  const add = (code, warn, message) => findings.push({ code, warn, message });
  if (Number(status.controllerMode) !== 2)
    add(
      'mode',
      true,
      status.controllerMode == null
        ? 'Tucor didn’t report the controller’s mode'
        : 'The controller isn’t in Automatic, so its programs won’t start',
    );
  const rain = Number(status.rainShutDown);
  if (status.rainShutDown == null || !Number.isFinite(rain))
    add('rain-unknown', true, 'Tucor didn’t report the rain delay');
  else if (rain > 0) {
    const hours = Math.max(1, Math.round(rain / 3600));
    const covers = firstStartInSeconds == null || rain > firstStartInSeconds;
    const who =
      rainSource === 'weather'
        ? '2core’s weather delay'
        : rainSource
          ? 'a rain delay set in 2core'
          : 'a rain delay set outside 2core';
    add(
      'rain',
      false,
      covers ? `Held by ${who}, ${hours} h left` : `${who[0].toUpperCase()}${who.slice(1)} ends before the first start`,
    );
  }
  if (alarms.length)
    add('alarm', true, `The controller reports ${alarms.length === 1 ? 'an alarm' : `${alarms.length} alarms`}`);
  if (codes.filter(c => /^I01(:|$)/.test(c)).at(-1) === 'I01:02')
    add('unsynced', true, 'Edits waiting in Tucor haven’t reached the controller');
  if (sync.state === 'controller changed') add('changed', true, sync.message);
  else if (sync.state === 'plan changed') add('plan-changed', false, sync.message);
  // Only meaningful while the controller holds the plan: then both should water the same zones tonight.
  if (sync.state === 'matches' && planRuns) {
    const controller = zoneList(runs),
      plan = zoneList(planRuns);
    if (controller.join() !== plan.join())
      add(
        'calendar',
        true,
        `Tonight the controller waters ${controller.length ? `zones ${controller.join(', ')}` : 'nothing'}, but the plan has ${plan.length ? `zones ${plan.join(', ')}` : 'nothing'}`,
      );
  }
  return findings;
}

/**
 * What the spot check saw.
 * @param {{ zone: string, expected: string[] }} target
 * @param {string[]} running Zones the controller reported running.
 * @param {{ controllerMode?: any, rainShutDown?: any }} status
 * @returns {{ outcome: string, warn: boolean, message: string }}
 */
export function spotOutcome(target, running, status) {
  if (running.includes(target.zone))
    return { outcome: 'seen running', warn: false, message: `Zone ${target.zone} was running` };
  const expected = running.filter(z => target.expected.includes(z));
  if (expected.length)
    return {
      outcome: 'seen running',
      warn: false,
      message: `Zone ${expected.join(', ')} was running, as planned for that minute`,
    };
  if (running.length)
    return {
      outcome: 'running, not as planned',
      warn: true,
      message: `Zone ${running.join(', ')} was running instead of zone ${target.zone}`,
    };
  if (Number(status.rainShutDown) > 0)
    return { outcome: 'held by rain', warn: false, message: 'Nothing was running; a rain delay was on' };
  if (Number(status.controllerMode) !== 2)
    return {
      outcome: 'not running when expected',
      warn: true,
      message: 'Nothing was running, and the controller wasn’t in Automatic',
    };
  return {
    outcome: 'not running when expected',
    warn: true,
    message: `Nothing was running when zone ${target.zone} should have been`,
  };
}

/**
 * One label for a night's record, most important first.
 * @param {any} night A stored night: `{ runs, evening?, spot?, target? }`.
 * @returns {{ status: string, warn: boolean }}
 */
export function nightStatus(night) {
  const evening = night.evening,
    spot = night.spot;
  if (spot && spot.warn) return { status: spot.outcome, warn: true };
  if (evening?.findings?.some(f => f.warn)) return { status: 'controller not ready', warn: true };
  if (spot?.outcome === 'seen running') return { status: 'seen running', warn: false };
  if (spot?.outcome === 'held by rain' || evening?.findings?.some(f => f.code === 'rain' && /^Held/.test(f.message)))
    return { status: 'held by rain', warn: false };
  if (!night.runs?.length && evening?.ok) return { status: 'nothing planned', warn: false };
  if (!evening && !night.closed) return { status: 'waiting', warn: false };
  if (evening?.ok)
    return { status: night.target && !spot && !night.closed ? 'ready' : 'ready, not seen running', warn: false };
  return { status: 'not checked', warn: false };
}
