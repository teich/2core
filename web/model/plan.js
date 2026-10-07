// Words and numbers for the Plan tab. Pure; the planning itself lives in
// lib/planner.mjs (shared with the server).
import { MAX_SECONDS, addDays, cadenceLabel, formatDuration } from '../../lib/planner.mjs';

export const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Zone problems that mean the person still has to set something. */
export const NEEDS = new Set(['unset', 'duration', 'cadence']);

/** A night's status pill: `[text, tone]`, keyed by resolvePlan's night status. */
export const NIGHT_STATUS = {
  ok: n => [`Done ${Math.round(n.sunrise - n.finish)} min before sunrise`, 'ok'],
  tight: n => [`Done ${Math.round(n.sunrise - n.finish)} min before sunrise`, 'warn'],
  late: n => [`Runs ${Math.round(n.finish - n.sunrise)} min past sunrise`, 'warn'],
  over: n => [`${n.deferred.length} zone${n.deferred.length > 1 ? 's don’t' : ' doesn’t'} fit`, 'bad'],
  rain: () => ['Rain hold', 'rain'],
  empty: () => ['Nothing due', ''],
};

/** Minutes after the evening's midnight-relative start as `10:30pm`, or `midnight`. */
export const clockAt = min => {
  const m = Math.round(min),
    h = Math.floor(m / 60) % 24,
    mm = m % 60;
  if (h === 0 && mm === 0) return 'midnight';
  return `${h % 12 || 12}:${String(mm).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
};

/** 10:00pm → 10pm, for compact labels. */
export const clockShort = min => clockAt(min).replace(':00', '');

/** Seconds in the fewest characters: `45s`, `12`, `12:30`, `1h05`. */
export const shortSeconds = seconds =>
  seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? seconds % 60
        ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
        : String(seconds / 60)
      : `${Math.floor(seconds / 3600)}h${Math.round((seconds % 3600) / 60) ? String(Math.round((seconds % 3600) / 60)).padStart(2, '0') : ''}`;

/** `Tonight`, `Tomorrow`, or `Fri 12` for night `d` after `start`. */
export const nightLabel = (start, d) =>
  d === 0 ? 'Tonight' : d === 1 ? 'Tomorrow' : `${WD[addDays(start, d).getDay()]} ${addDays(start, d).getDate()}`;

/** The run-length stepper: fine steps for short runs, coarser for long ones. */
export const stepMinutes = (minutes, direction) => {
  const step = direction > 0 ? (minutes < 10 ? 1 : minutes < 60 ? 5 : 15) : minutes <= 10 ? 1 : minutes <= 60 ? 5 : 15;
  const next = direction > 0 ? Math.floor(minutes / step) * step + step : Math.ceil(minutes / step) * step - step;
  return Math.max(1, Math.min(MAX_SECONDS / 60, next));
};

/** Seasonal adjustment is 50–200%. */
export const clampPercent = value => Math.max(50, Math.min(200, Math.round(value)));

/** Structural equality for plain JSON values. */
export const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The trade-offs a scenario accepts, in sentences; '' when there are none. */
export function consequenceText(r) {
  return [
    r.newParallelSeconds ? `${formatDuration(r.newParallelSeconds)} of two zones at once over fourteen nights.` : '',
    r.additionalOverlapSeconds
      ? `${formatDuration(r.additionalOverlapSeconds)} more time with two zones at once, over ${r.affectedNights} night${r.affectedNights === 1 ? '' : 's'}.`
      : '',
    r.laterFinishNights
      ? `Finishes later on ${r.laterFinishNights} night${r.laterFinishNights === 1 ? '' : 's'}; latest ${clockAt(r.latestFinish)}.`
      : '',
    r.afterPreferredNights
      ? `${r.afterPreferredNights} night${r.afterPreferredNights === 1 ? '' : 's'} finish after your target.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

const EDIT_LABELS = {
  seconds: 'run length',
  cadence: 'how often',
  enabled: 'watering',
  waterDuringRain: 'water during rain',
  seasonalPercent: 'seasonal',
  firstDue: 'next watering',
};
const editValue = (key, value) =>
  key === 'seconds'
    ? value == null
      ? 'not set'
      : formatDuration(value)
    : key === 'cadence'
      ? cadenceLabel(value)
      : key === 'seasonalPercent'
        ? `${value ?? 100}%`
        : typeof value === 'boolean'
          ? value
            ? 'on'
            : 'off'
          : String(value ?? 'not set');

/**
 * An unsaved edit as `[who, what]` lines, such as `['Roses', 'run length 10 min → 15 min']`.
 * @param {any} edit The pending change sent to /plan/edit-preview.
 * @param {Record<string, any>} saved Saved intents by zone id.
 * @param {(id: string) => string} zoneName
 */
export function editLines(edit, saved, zoneName) {
  const lines = Object.entries(edit.intents ?? {}).flatMap(([id, patch]) =>
    Object.entries(patch).map(([key, value]) => [
      zoneName(id),
      `${EDIT_LABELS[key] ?? key} ${editValue(key, saved[id]?.[key])} → ${editValue(key, value)}`,
    ]),
  );
  if (edit.seasonalPercent != null) lines.push(['All zones', `seasonal → ${edit.seasonalPercent}%`]);
  for (const [key, value] of Object.entries(edit.settings ?? {}))
    lines.push([
      'Night',
      key === 'lanes'
        ? `zones at once → ${value === 1 ? 'one' : 'up to two'}`
        : key === 'finishBeforeSunrise'
          ? `finish ${value ? `${value} min before sunrise` : 'by sunrise'}`
          : `${key === 'earliestStart' ? 'start after' : 'never past'} ${clockAt(value)}`,
    ]);
  if (edit.rebalanceToken) lines.push(['Dates', 'apply the reviewed rebalance']);
  if (edit.seasonalZoneIds) lines.push(['Seasonal comparison', 'update the zones it checks']);
  return lines;
}
