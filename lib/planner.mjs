// Turns each zone's watering intention into a projected run of nights.
// Pure and dependency-free: the server tests it and the web app runs the same file
// so edits show their consequences immediately. Times are minutes after the local
// midnight that starts a night's evening date, so 1:30am the next morning is 1530.

export const DEFAULT_SETTINGS = Object.freeze({ earliestStart: 22 * 60, finishBeforeSunrise: 15, hardDeadline: 9 * 60, lanes: 2 });
export const SETTING_LIMITS = Object.freeze({
  earliestStart: [18 * 60, 26 * 60], finishBeforeSunrise: [0, 120], hardDeadline: [4 * 60, 12 * 60], lanes: [1, 2],
});
export const MAX_SECONDS = 4 * 3600;
export const NIGHTS = 14;
// Used until the Tempest has reported where it is.
export const FALLBACK_SUNRISE = 6 * 60 + 30;
// Most frequent first. A cadence is { every: n } days or { perWeek: n }.
export const CADENCES = [
  { every: 1 }, { every: 2 }, { perWeek: 3 }, { every: 3 }, { perWeek: 2 }, { every: 4 }, { every: 5 }, { every: 7 }, { every: 10 }, { every: 14 },
];

export const cadenceKey = c => (c?.every ? `d${c.every}` : c?.perWeek ? `w${c.perWeek}` : '');
export const cadenceFromKey = key => {
  const match = /^([dw])(\d+)$/.exec(key ?? '');
  return match ? (match[1] === 'd' ? { every: Number(match[2]) } : { perWeek: Number(match[2]) }) : null;
};
export function cadenceLabel(c) {
  if (c?.every) return c.every === 1 ? 'Every day' : c.every === 7 ? 'Weekly' : c.every === 14 ? 'Every 2 weeks' : `Every ${c.every} days`;
  if (c?.perWeek) return c.perWeek === 1 ? 'Once a week' : c.perWeek === 2 ? 'Twice a week' : `${c.perWeek}× a week`;
  return 'Not set';
}

// Gaps in days between waterings. Several times a week spreads seven days as evenly
// as whole days allow: twice a week alternates 3 and 4.
export function gaps(cadence) {
  if (cadence?.every) return [cadence.every];
  const n = cadence.perWeek, base = Math.floor(7 / n), extra = 7 % n;
  return Array.from({ length: n }, (_, i) => (i < n - extra ? base : base + 1));
}
export function weeklySeconds(intent) {
  const g = gaps(intent.cadence);
  return intent.seconds * 7 * g.length / g.reduce((a, b) => a + b, 0);
}

// Accepts 25 (minutes), 7.5, 1:30 (min:sec), 20s, 2h, 1h30. Returns seconds, null when empty, NaN when unreadable.
export function parseDuration(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  let m = /^(\d+):([0-5]?\d)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+)\s*h(?:\s*(\d+)\s*m?(?:in)?)?$/.exec(t);
  if (m) return Number(m[1]) * 3600 + Number(m[2] ?? 0) * 60;
  m = /^(\d+)\s*s(?:ec)?$/.exec(t);
  if (m) return Number(m[1]);
  m = /^(\d+(?:\.\d+)?)\s*(?:m|min)?$/.exec(t);
  if (m) return Math.round(Number(m[1]) * 60);
  return NaN;
}
// The form a person would type back: 25, 7:30, 0:20, 2h, 1h30.
export function durationText(seconds) {
  if (!seconds) return '';
  if (seconds % 60) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const m = seconds / 60;
  if (m < 60 || m % 60 && m < 120) return String(m);
  return `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
}
export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} sec`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

// Local calendar dates as YYYY-MM-DD.
export const dateKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const fromKey = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysBetween = (a, b) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5);
export const validDateKey = key => typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key) && dateKey(fromKey(key)) === key;

// A night belongs to the evening it starts on: before noon, "tonight" is the one still under way.
export const currentNight = (now = new Date()) => addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), now.getHours() < 12 ? -1 : 0);

// Local sunrise in minutes after midnight, from the standard almanac approximation
// (within a couple of minutes at garden latitudes). Null when the sun doesn't rise.
export function sunrise(date, latitude, longitude) {
  const rad = Math.PI / 180, wrap = (x, n) => ((x % n) + n) % n;
  const day = daysBetween(new Date(date.getFullYear(), 0, 1), date) + 1;
  const lngHour = longitude / 15, t = day + (6 - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  const L = wrap(M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634, 360);
  let RA = wrap(Math.atan(0.91764 * Math.tan(L * rad)) / rad, 360);
  RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
  const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(latitude * rad)) / (cosDec * Math.cos(latitude * rad));
  if (cosH > 1 || cosH < -1) return null;
  const H = (360 - Math.acos(cosH) / rad) / 15;
  const UT = wrap(H + RA - 0.06571 * t - 6.622 - lngHour, 24);
  const at = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) + UT * 3600000);
  // The UTC date can differ from the local one; only the local clock time matters.
  return at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60;
}

export function intentProblem(intent) {
  if (intent?.enabled === false) return 'paused';
  if (!intent?.seconds && !intent?.cadence) return 'unset';
  if (!intent.seconds) return 'duration';
  if (!intent.cadence) return 'cadence';
  return null;
}

// Place only unanchored zones; existing dates are never rebalanced implicitly.
// The caller persists the returned dates so reopening or editing cannot move them.
// Balance twelve weeks of zone-time, longest weekly demand first. This is a
// small greedy heuristic, not a guarantee of optimal packing into lanes.
export function staggerIntents(intents, anchor = currentNight()) {
  const horizon = 84;
  let loads = Array(horizon).fill(0);
  const out = Object.fromEntries(Object.entries(intents).map(([id, i]) => [id, { ...i }]));
  const active = Object.entries(intents).filter(([, i]) => !intentProblem(i))
    .sort(([a, x], [b, y]) => weeklySeconds(y) - weeklySeconds(x) || Number(a) - Number(b));
  for (const [, intent] of active.filter(([, i]) => i.firstDue)) {
    const g = gaps(intent.cadence);
    for (let day = daysBetween(anchor, fromKey(intent.firstDue)), phase = 0; day < horizon; day += g[phase++ % g.length]) {
      if (day >= 0) loads[day] += intent.seconds;
    }
  }
  for (const [id, intent] of active.filter(([, i]) => !i.firstDue)) {
    const g = gaps(intent.cadence), period = g.reduce((a, b) => a + b, 0);
    let best;
    for (let offset = 0; offset < period; offset++) {
      const candidate = [...loads];
      for (let day = offset - period, phase = 0; day < horizon; day += g[phase++ % g.length]) {
        if (day >= 0) candidate[day] += intent.seconds;
      }
      const peak = Math.max(...candidate), squares = candidate.reduce((a, x) => a + x * x, 0);
      if (!best || peak < best.peak || peak === best.peak && squares < best.squares) best = { offset, candidate, peak, squares };
    }
    loads = best.candidate;
    // Use the first occurrence on/after the anchor, preserving the gap phase by
    // keeping the previous cycle's anchor for multi-gap cadences.
    out[id].firstDue = dateKey(addDays(anchor, best.offset - period));
  }
  return out;
}

// Explicit rebalancing moves as few zones as this greedy pass can: choose one
// improvement at a time, require a lower busiest-night load, and stop when no
// single move helps. Never move the same zone twice in one proposal.
export function proposeRebalance(intents, start = currentNight()) {
  const horizon = 84, next = structuredClone(intents);
  const active = Object.keys(next).filter(id => !intentProblem(next[id]) && next[id].firstDue)
    .sort((a, b) => Number(a) - Number(b));
  const workload = values => {
    const loads = Array(horizon).fill(0);
    for (const id of active) {
      const i = values[id], g = gaps(i.cadence);
      for (let d = daysBetween(start, fromKey(i.firstDue)), phase = 0; d < horizon; d += g[phase++ % g.length]) {
        if (d >= 0) loads[d] += i.seconds;
      }
    }
    return Math.max(0, ...loads);
  };
  const beforePeak = workload(next), changes = [];
  let peak = beforePeak;
  const moved = new Set();
  for (let pass = 0; pass < active.length; pass++) {
    let best;
    for (const id of active.filter(id => !moved.has(id))) {
      const intent = next[id], before = nextDueDate(intent, start);
      const maxShift = Math.max(...gaps(intent.cadence)) - 1;
      for (let shift = -maxShift; shift <= maxShift; shift++) {
        if (!shift) continue;
        const after = dateKey(addDays(fromKey(before), shift));
        if (after < dateKey(start)) continue;
        const candidate = { ...intent, firstDue: dateKey(addDays(fromKey(intent.firstDue), shift)) };
        // Do not introduce an extra occurrence before the disclosed next run.
        if (nextDueDate(candidate, start) !== after) continue;
        const candidatePeak = workload({ ...next, [id]: candidate });
        if (candidatePeak >= peak) continue;
        if (!best || candidatePeak < best.peak || candidatePeak === best.peak && Math.abs(shift) < Math.abs(best.shift)) {
          best = { id, before, after, shift, peak: candidatePeak, candidate };
        }
      }
    }
    if (!best) break;
    next[best.id] = best.candidate; moved.add(best.id); peak = best.peak;
    changes.push({ zone: best.id, before: best.before, after: best.after, days: best.shift, firstDue: best.candidate.firstDue });
  }
  return { changes, beforePeakSeconds: beforePeak, afterPeakSeconds: peak };
}

// Preserve the next promised night when changing frequency in the preview.
// Live execution will need durable due/completion records, not projected history.
export function nextDueDate(intent, start) {
  const g = gaps(intent.cadence);
  let due = daysBetween(start, fromKey(intent.firstDue)), phase = 0;
  while (due < 0) due += g[phase++ % g.length];
  return dateKey(addDays(start, due));
}

/**
 * Projects the next `nights` nights.
 * zones: [{ id }] in display order; intents: { [id]: { seconds, cadence, enabled, firstDue } }.
 * start: local Date of the first night's evening. rain: Set of date keys under a rain hold.
 * sunriseAt(date): minutes after midnight on that morning, or null when unknown.
 *
 * Before live operation nothing records waterings, so a first due date in the past
 * rolls forward as though each watering happened on time.
 */
export function resolvePlan({ zones, intents = {}, settings = DEFAULT_SETTINGS, start, nights = NIGHTS, rain = new Set(), sunriseAt = () => null }) {
  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  const lanes = cfg.lanes, earliest = cfg.earliestStart, hard = 1440 + cfg.hardDeadline;
  const capacity = (hard - earliest) * 60;
  const sim = zones.map(zone => {
    const intent = intents[zone.id] ?? {};
    const problem = intentProblem(intent);
    const s = { id: zone.id, intent, problem, active: !problem, seconds: intent.seconds ?? 0, due: 0, phase: 0, reason: null, cells: [] };
    if (s.active) {
      const g = gaps(intent.cadence);
      s.due = intent.firstDue ? daysBetween(start, fromKey(intent.firstDue)) : 0;
      while (s.due < 0) s.due += g[s.phase++ % g.length];
      s.weekly = weeklySeconds(intent);
    }
    return s;
  });
  const out = [];
  for (let d = 0; d < nights; d++) {
    const date = addDays(start, d), key = dateKey(date);
    const known = sunriseAt(addDays(date, 1));
    const sun = 1440 + (known ?? FALLBACK_SUNRISE);
    const night = { date: key, rain: rain.has(key), sunrise: sun, sunriseKnown: known != null, preferredFinish: sun - cfg.finishBeforeSunrise,
      earliestStart: earliest, hardDeadline: hard, lanes: [], deferred: [], held: [], late: [], start: null, finish: null, seconds: 0, needMinutes: 0 };
    const held = new Set(sim.filter(s => night.rain && s.active && s.due <= d && s.intent.waterDuringRain !== true));
    for (const s of held) { s.reason = 'rain'; night.held.push(s.id); }
    // Overdue first, then longest first; ties keep zone order.
    const due = sim.filter(s => s.active && s.due <= d && !held.has(s)).sort((a, b) => (a.due - b.due) || (b.seconds - a.seconds));
    const loads = Array(lanes).fill(0), lists = Array.from({ length: lanes }, () => []);
    const placed = new Set();
    for (const s of due) {
      const lane = loads.indexOf(Math.min(...loads));
      if (loads[lane] + s.seconds <= capacity) { loads[lane] += s.seconds; lists[lane].push(s); placed.add(s); }
      else night.deferred.push(s.id);
    }
    if (night.deferred.length) {
      // A quick lower bound; the greedy packing failing is not proof nothing fits.
      const total = due.reduce((a, s) => a + s.seconds, 0), longest = Math.max(...due.map(s => s.seconds));
      night.needMinutes = Math.max(1, Math.ceil((Math.max(longest, total / lanes) - capacity) / 60));
    }
    if (placed.size) {
      const length = Math.max(...loads) / 60;
      night.start = Math.max(earliest, night.preferredFinish - length);
      night.finish = night.start + length;
    }
    night.seconds = loads.reduce((a, b) => a + b, 0);
    night.lanes = lists.map(list => {
      let t = night.start;
      return list.map(s => {
        const run = { zone: s.id, seconds: s.seconds, from: t, to: t + s.seconds / 60, late: d - s.due, reason: d > s.due ? s.reason : null };
        t = run.to;
        return run;
      });
    });
    for (const s of sim) {
      if (placed.has(s)) {
        const late = d - s.due;
        s.cells[d] = { kind: 'water', late };
        if (late > 0) night.late.push({ zone: s.id, nights: late, reason: s.reason });
        const g = gaps(s.intent.cadence);
        s.due = d + g[s.phase++ % g.length];
        s.reason = null;
      } else if (held.has(s)) {
        s.cells[d] = { kind: 'held' };
      } else if (night.deferred.includes(s.id)) {
        s.cells[d] = { kind: 'deferred' };
        s.reason = 'overflow';
      } else s.cells[d] = { kind: 'none' };
    }
    out.push(finish(night));
  }
  return {
    nights: out,
    zones: sim.map(s => ({ id: s.id, problem: s.problem, weeklySeconds: s.weekly ?? 0, cells: s.cells, next: s.cells.findIndex(c => c.kind === 'water') })),
  };
}

function finish(night) {
  night.status = night.rain && night.start == null && !night.deferred.length ? 'rain'
    : night.start == null ? (night.deferred.length ? 'over' : 'empty')
    : night.deferred.length ? 'over'
    : night.finish > night.sunrise ? 'late'
    : night.finish > night.preferredFinish + 0.5 ? 'tight'
    : 'ok';
  return night;
}
