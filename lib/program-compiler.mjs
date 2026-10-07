// Dry-run intermediate representation only. No vendor packets, sync or writes.
import {
  DEFAULT_SETTINGS,
  FALLBACK_SUNRISE,
  addDays,
  adjustedSeconds,
  dateKey,
  fromKey,
  gaps,
  intentProblem,
} from './planner.mjs';

const DAYS = 14;
const sum = xs => xs.reduce((a, b) => a + b, 0);
const intersects = (a, b) => a.mask.some((on, d) => on && b.mask[d]);
const overlap = (a, b) => Math.max(0, Math.min(a.at + a.seconds, b.at + b.seconds) - Math.max(a.at, b.at));

function metrics(jobs) {
  const nights = Array.from({ length: DAYS }, (_, d) => {
    const runs = jobs.filter(j => j.mask[d]),
      events = runs
        .flatMap(j => [
          [j.at, 1],
          [j.at + j.seconds, -1],
        ])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let count = 0,
      peak = 0,
      parallelSeconds = 0,
      previous = 0;
    for (const [at, change] of events) {
      if (count > 1) parallelSeconds += at - previous;
      count += change;
      peak = Math.max(peak, count);
      previous = at;
    }
    return {
      seconds: sum(runs.map(j => j.seconds)),
      parallelSeconds,
      peak,
      start: runs.length ? Math.min(...runs.map(j => j.at)) : null,
      finish: runs.length ? Math.max(...runs.map(j => j.at + j.seconds)) : null,
    };
  });
  return {
    nights,
    overlap: sum(nights.map(n => n.parallelSeconds)),
    span: Math.max(0, ...jobs.map(j => j.at + j.seconds)),
  };
}

// Serial schedule generation enumerates precedence orders, stopping at the
// nightly workload lower bound or a deterministic node budget. A missed fit is
// reported as a search limitation, never as proof of impossibility.
function sequential(groups, window, lowerBound) {
  let best = null,
    visits = 0;
  function search(jobs, remaining, span) {
    if (++visits > 30000 || best?.span === lowerBound) return;
    if (!remaining.length) {
      best = { jobs, span, overlap: 0 };
      return;
    }
    for (const g of remaining) {
      const at = Math.ceil(Math.max(0, ...jobs.filter(j => intersects(g, j)).map(j => j.at + j.seconds)) / 60) * 60;
      const end = Math.max(span, at + g.seconds);
      if (end > window || (best && end >= best.span)) continue;
      search(
        [...jobs, { ...g, at }],
        remaining.filter(x => x !== g),
        end,
      );
    }
  }
  search([], groups, 0);
  return best;
}

function placements(g, jobs, window) {
  // Whole-minute program starts; runtimes retain supported second precision.
  const points = [
    0,
    ...(g.at == null ? [] : [g.at]),
    window - g.seconds,
    ...jobs.flatMap(j => [j.at, j.at + j.seconds, j.at - g.seconds, j.at + j.seconds - g.seconds]),
  ];
  return [...new Set(points.flatMap(x => [Math.floor(x / 60) * 60, Math.ceil(x / 60) * 60]))]
    .filter(x => x >= 0 && x + g.seconds <= window)
    .sort((a, b) => a - b);
}
function allowed(g, jobs, at) {
  const candidate = { ...g, at };
  const conflicts = jobs.filter(j => intersects(g, j) && overlap(candidate, j) > 0);
  for (let i = 0; i < conflicts.length; i++)
    for (let k = i + 1; k < conflicts.length; k++) {
      const a = conflicts[i],
        b = conflicts[k];
      if (
        g.mask.some((on, d) => on && a.mask[d] && b.mask[d]) &&
        Math.max(at, a.at, b.at) < Math.min(at + g.seconds, a.at + a.seconds, b.at + b.seconds)
      )
        return false;
    }
  return true;
}
function addedOverlap(g, jobs, at) {
  return sum(jobs.map(j => overlap({ ...g, at }, j) * g.mask.filter((on, d) => on && j.mask[d]).length));
}
function parallel(groups, window, overlapBound) {
  let best = null,
    seed = 1741;
  const byLength = [...groups].sort((a, b) => b.seconds - a.seconds || a.index - b.index);
  for (let trial = 0; trial < 128; trial++) {
    const order = [...byLength];
    if (trial)
      for (let i = order.length - 1; i > 0; i--) {
        seed = (seed * 16807) % 2147483647;
        const j = seed % (i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
    let jobs = [];
    for (const g of order) {
      const choices = placements(g, jobs, window)
        .filter(at => allowed(g, jobs, at))
        .map(at => ({ at, cost: addedOverlap(g, jobs, at) }));
      choices.sort((a, b) => a.cost - b.cost || a.at - b.at);
      if (!choices.length) break;
      jobs.push({ ...g, at: choices[0].at });
    }
    if (jobs.length !== groups.length) continue;
    // Coordinate descent improves the complete schedule without changing masks.
    for (let pass = 0; pass < 3; pass++)
      for (const job of [...jobs]) {
        const others = jobs.filter(j => j.index !== job.index);
        const oldCost = addedOverlap(job, others, job.at);
        const options = placements(job, others, window)
          .filter(at => allowed(job, others, at))
          .map(at => ({ at, cost: addedOverlap(job, others, at) }));
        options.sort((a, b) => a.cost - b.cost || a.at - b.at);
        if (options[0].cost < oldCost) jobs = [...others, { ...job, at: options[0].at }];
      }
    const score = metrics(jobs);
    if (!best || score.overlap < best.overlap || (score.overlap === best.overlap && score.span < best.span))
      best = { jobs, ...score };
    if (best.overlap === overlapBound) break;
  }
  return best;
}

// Split an oversized calendar group into whole-zone programs when spare slots
// allow it. This changes the encoding only, never watering dates or amounts.
function splitGroups(groups, window) {
  const out = [];
  for (const group of groups) {
    if (group.seconds <= window) {
      out.push(group);
      continue;
    }
    const bins = [];
    for (const step of [...group.steps].sort((a, b) => b.seconds - a.seconds || Number(a.zone) - Number(b.zone))) {
      if (step.seconds > window) return null;
      let bin = bins.find(b => b.seconds + step.seconds <= window);
      if (!bin) bins.push((bin = { ...group, steps: [], seconds: 0 }));
      bin.steps.push(step);
      bin.seconds += step.seconds;
    }
    out.push(...bins);
  }
  return out.length <= 10 ? out.map((g, index) => ({ ...g, index })) : null;
}

/** Compiler input is a dry, stable intention snapshot. Rain amount/soil credit
 * belongs to a future policy layer that changes due dates/durations explicitly.
 * enabledOverrides affects this result only; it never edits the saved plan.
 */
export function compilePrograms({
  zones,
  intents = {},
  settings = {},
  start,
  sunriseAt = () => null,
  enabledOverrides = {},
}) {
  const cfg = { ...DEFAULT_SETTINGS, ...settings },
    issues = [],
    groups = [];
  const dates = Array.from({ length: DAYS }, (_, d) => dateKey(addDays(start, d)));
  const suns = dates.map((_, d) => sunriseAt(addDays(start, d + 1)));
  const preferredFinish = Math.floor(
    Math.min(1440 + cfg.hardDeadline, ...suns.map(s => 1440 + (s ?? FALLBACK_SUNRISE) - cfg.finishBeforeSunrise)),
  );
  const earliest = cfg.earliestStart * 60,
    hard = (1440 + cfg.hardDeadline) * 60;
  const preferredWindow = Math.max(0, preferredFinish * 60 - earliest),
    hardWindow = hard - earliest;
  for (const zone of [...zones].sort((a, b) => Number(a.id) - Number(b.id))) {
    const intent = { ...intents[zone.id] };
    if (Object.hasOwn(enabledOverrides, zone.id)) intent.enabled = enabledOverrides[zone.id];
    const problem = intentProblem(intent);
    if (problem) {
      if (problem !== 'paused')
        issues.push({
          code: 'incomplete-intent',
          zone: zone.id,
          message: `${zone.name ?? zone.id}: watering intention is incomplete.`,
        });
      continue;
    }
    const cycle = gaps(intent.cadence),
      period = sum(cycle),
      seconds = adjustedSeconds(intent);
    if (DAYS % period) {
      issues.push({
        code: 'cadence',
        zone: zone.id,
        message: `${zone.name ?? zone.id}: cadence does not repeat within 14 days.`,
      });
      continue;
    }
    if ((seconds >= 240 && seconds % 10) || seconds > 999 * 60) {
      issues.push({
        code: 'runtime-precision',
        zone: zone.id,
        message: `${zone.name ?? zone.id}: ${seconds} seconds is not exactly representable by the documented LTD runtime precision. No rounding applied.`,
      });
      continue;
    }
    let due = intent.firstDue ? fromKey(intent.firstDue) : start,
      phase = 0;
    while (due < start) due = addDays(due, cycle[phase++ % cycle.length]);
    const mask28 = Array(28).fill(false);
    for (let d = 0; d < 28; d++) {
      if (dateKey(due) === dateKey(addDays(start, d))) {
        mask28[d] = true;
        due = addDays(due, cycle[phase++ % cycle.length]);
      }
    }
    if (!mask28.slice(0, 14).some(Boolean) || mask28.slice(0, 14).some((on, d) => on !== mask28[d + 14])) {
      issues.push({
        code: 'transient-dates',
        zone: zone.id,
        message: `${zone.name ?? zone.id}: the initial due date needs a transition before a repeating installation.`,
      });
      continue;
    }
    const mask = mask28.slice(0, 14),
      rain = intent.waterDuringRain === true;
    let group = groups.find(g => g.waterDuringRain === rain && g.mask.every((on, d) => on === mask[d]));
    if (!group) groups.push((group = { index: groups.length, mask, waterDuringRain: rain, seconds: 0, steps: [] }));
    group.steps.push({ zone: zone.id, name: zone.name ?? `Zone ${zone.id}`, seconds });
    group.seconds += seconds;
  }
  const loads = dates.map((_, d) => sum(groups.filter(g => g.mask[d]).map(g => g.seconds)));
  const peak = Math.max(0, ...loads);
  if (groups.length > 10)
    issues.push({
      code: 'program-limit',
      message: `${groups.length} calendar/rain groups exceed 10 programs. This compiler does not merge differing calendars.`,
    });
  const result = {
    dryRun: true,
    status: 'blocked',
    calendarAnchor: dates[0],
    dates,
    enabledOverrides,
    settings: cfg,
    horizon: {
      earliestStart: cfg.earliestStart,
      preferredFinish,
      hardDeadline: hard / 60,
      through: dates.at(-1),
      sunriseKnown: suns.every(s => s != null),
    },
    summary: {
      zones: sum(groups.map(g => g.steps.length)),
      programs: groups.length,
      weeklySeconds: sum(loads) / 2,
      peakNightSeconds: peak,
      longestRunSeconds: Math.max(0, ...groups.flatMap(g => g.steps.map(s => s.seconds))),
    },
    issues,
    programs: [],
    nights: [],
    assumptions: [
      'Dry weather only. Rain credit, catch-up dates and rain exemptions are not implemented in controller execution.',
      'Calendar masks are relative to the evening anchor. Controller calendar alignment, step capacity, clock/DST and write/readback still need validation.',
      'One-minute starts, documented LTD runtime precision, and 100% program budgets; controller ET/budget modifiers must not rescale compiled durations.',
      'The schedule is evaluated for these 14 nights; sunrise drift needs review before reusing it beyond this horizon.',
    ],
  };
  if (issues.length) return result;
  // First choose serial operation within the preferred window. Only then allow
  // a second concurrent zone; later finishes are a fallback, not the default.
  function solve(window) {
    const split = splitGroups(groups, window);
    for (const candidate of [groups, ...(split && split.length !== groups.length ? [split] : [])]) {
      const serial = peak <= window ? sequential(candidate, window, peak) : null;
      if (serial) return serial;
      if (cfg.lanes === 2 && peak <= 2 * window && candidate.every(g => g.seconds <= window)) {
        const found = parallel(candidate, window, sum(loads.map(n => Math.max(0, n - window))));
        if (found) return found;
      }
    }
    return null;
  }
  let window = preferredWindow,
    solution = solve(window);
  if (!solution && hardWindow > window) {
    window = hardWindow;
    solution = solve(window);
  }
  if (!solution) {
    issues.push({
      code: 'no-fit',
      message:
        'No fixed-start arrangement found within the window and concurrency limit. A different encoding or search may fit; no runs were shortened or deferred.',
    });
    return result;
  }
  // Shift the whole arrangement towards the chosen finish, preserving conflicts.
  const shift = Math.floor((window - solution.span) / 60) * 60;
  const jobs = solution.jobs.map(j => ({ ...j, at: j.at + earliest + shift })).sort((a, b) => a.index - b.index);
  const measured = metrics(jobs);
  result.status = 'candidate';
  result.programs = jobs.map((j, i) => {
    const dayOffset = Math.floor(j.at / 86400);
    const calendarMask = j.mask.map((_, d) => j.mask[(d - dayOffset + DAYS) % DAYS]);
    return {
      slot: i + 1,
      budgetPercent: 100,
      waterDuringRain: j.waterDuringRain,
      eveningMask: j.mask,
      calendarMask,
      startMinute: j.at / 60,
      clockMinute: (j.at / 60) % 1440,
      startDayOffset: dayOffset,
      seconds: j.seconds,
      steps: j.steps,
    };
  });
  result.nights = measured.nights.map((n, d) => ({
    date: dates[d],
    ...n,
    start: n.start == null ? null : n.start / 60,
    finish: n.finish == null ? null : n.finish / 60,
  }));
  Object.assign(result.summary, {
    programs: jobs.length,
    maxConcurrent: Math.max(0, ...measured.nights.map(n => n.peak)),
    parallelSeconds: measured.overlap,
    parallelLowerBoundSeconds: sum(loads.map(n => Math.max(0, n - window))),
    preferredWindowMet: result.nights.every(n => n.finish == null || n.finish <= preferredFinish),
    minimumOverlapProven: measured.overlap === sum(loads.map(n => Math.max(0, n - window))),
    search: 'bounded deterministic search; a feasible candidate is not necessarily optimal',
  });
  return result;
}
