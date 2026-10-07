// The Weather view's words and numbers: rain delay, station health and the
// automatic policy's latest decision. Pure; pass `now` and the display unit.
import { ago, hoursLeft, whenAt, at } from '../core/format.js';

export const MODE_TEXT = {
  off: 'Weather is ignored and the station isn’t read.',
  observe: 'Watches the weather and records what it would do. It never changes the controller.',
  automatic: 'Sets a rain delay when a threshold is met. It never shortens a delay you set.',
};

/** Values arrive in millimeters; show them in whatever the station reports. */
export const rainUnit = (state, language = globalThis.navigator?.language) =>
  state.weatherReading?.sample?.unit || (language === 'en-US' ? 'in' : 'mm');

/** Readings show a trace as "<0.01"; thresholds (`trace` false) round to a plain figure. */
export const depth = (mm, unit, trace = true) => {
  const v = unit === 'in' ? mm / 25.4 : mm,
    places = unit === 'in' ? 2 : 1;
  return trace && v > 0 && v < 10 ** -places
    ? `<${(10 ** -places).toFixed(places)}`
    : v < 10
      ? Math.max(v, trace ? 0 : 10 ** -places).toFixed(places)
      : Math.round(v).toString();
};

export const limit = (mm, unit) => depth(mm, unit, false);

/** Why a delay was (or would be) set, from the policy's trigger. */
export const because = (reason, trigger, unit) =>
  !trigger
    ? reason
    : trigger.kind === 'intensity'
      ? `Raining ${depth(trigger.mm, unit)} ${unit}/h`
      : trigger.kind === 'accumulation'
        ? `${depth(trigger.mm, unit)} ${unit} of rain today`
        : `Forecast of ${depth(trigger.mm, unit)} ${unit} at ${Math.round(trigger.probability)}%`;

/** The rain delay, counted down from the controller's last report. */
export function rainDelay(state, unit, now) {
  const observed = Date.parse(state.observedAt);
  const reported = Number(state.status.rainShutDown) || 0;
  const remaining = Math.max(0, reported - (Number.isFinite(observed) ? (now - observed) / 1000 : 0));
  const on = remaining > 0,
    rain = state.rain;
  // Ours when it ends within three minutes of the delay 2core recorded setting.
  const ours = Boolean(on && rain && Math.abs(Date.parse(rain.until) - (now + remaining * 1000)) < 180000);
  const origin = !on
    ? ''
    : ours
      ? rain.source === 'weather'
        ? `Set by the weather: ${because(rain.reason, rain.trigger, unit)}`
        : 'Set from 2core'
      : 'Set at the controller or in Tucor';
  const asOf = !state.available && state.observedAt ? ` As of ${at(observed)}.` : '';
  return {
    on,
    remaining,
    title: on ? `${hoursLeft(remaining)} left` : 'Off',
    detail: on
      ? `Until ${whenAt(now + remaining * 1000, now)}. ${origin}.${asOf}`
      : `The controller’s schedule runs as normal.${asOf}`,
    /** Percent of 2core's own delay still to go, or null when the meter should hide. */
    meter: ours && rain.hours ? Math.min(100, remaining / (rain.hours * 36)) : null,
  };
}

/** The station pill (`[text, tone]`) and the note under the readings. */
/** @param {import('../core/app.js').ServerState} state */
export function stationHealth({ weatherSource: source, weatherReading: reading, policy }, now) {
  const age = reading?.at ? now - Date.parse(reading.at) : Infinity;
  const failing = reading?.error && (!reading.at || Date.parse(reading.errorAt) >= Date.parse(reading.at));
  if (!source?.configured)
    return source?.error
      ? { pill: ['Setup problem', 'bad'], note: `${source.error}.` }
      : {
          pill: ['Not set up', ''],
          note: 'On the server, run tools/configure-secrets.py --weatherflow to connect your Tempest.',
        };
  if (policy.mode === 'off') return { pill: ['Paused', ''], note: 'Not reading while automatic rain delay is off.' };
  if (failing)
    return {
      pill: [/fresh/.test(reading.error) ? 'No readings' : 'Can’t connect', 'bad'],
      note: `${reading.error}${reading.at ? `. Last good reading ${ago(reading.at, now)}` : ''}. Missing readings never count as dry.`,
    };
  if (reading?.at)
    return {
      pill: age < 11 * 60000 ? [`Live · ${ago(reading.at, now)}`, 'ok'] : [`Last read ${ago(reading.at, now)}`, 'warn'],
      note: `${source.source === 'Simulator' ? 'Sample data' : `Station ${source.station?.id} via WeatherFlow`}. Checked every 5 minutes.`,
    };
  return { pill: ['Connecting', 'warn'], note: 'Waiting for the first reading.' };
}

/**
 * The latest automatic-delay decision as an icon tone, a title and a detail line.
 * @param {import('../core/app.js').ServerState} state
 * @returns {{ tone: 'clock' | 'danger' | 'leaf' | 'water' | 'soft-water' | 'amber', title: string, detail: string }}
 */
export function decisionSummary({ weatherDecision: d, policy, weatherSource: source }, unit, now) {
  if (policy.mode === 'off')
    return { tone: 'clock', title: 'Not watching', detail: 'Choose Log only to see what 2core would do.' };
  if (!d)
    return {
      tone: 'clock',
      title: 'No decision yet',
      detail: source?.configured ? 'The first one comes with the next reading.' : 'Set up a weather source first.',
    };
  const when = `Checked ${ago(d.at, now)}`,
    why = because(d.reason, d.trigger, unit),
    would = `Would set a ${policy.holdHours} h delay`;
  if (/^Rain delay not set/.test(d.reason))
    return {
      tone: 'danger',
      title: 'Couldn’t set a delay',
      detail: `${d.reason.replace(/^Rain delay not set: /, '')}. ${when}.`,
    };
  if (!d.wet)
    return {
      tone: 'leaf',
      title: 'Dry, nothing to do',
      detail: /stale|missing/i.test(d.reason) ? `${d.reason}. ${when}.` : `No threshold met. ${when}.`,
    };
  if (d.applied) return { tone: 'water', title: `Set a ${policy.holdHours} h delay`, detail: `${why}. ${when}.` };
  if (d.preserved) return { tone: 'soft-water', title: 'Delay already in place', detail: `${d.preserved}. ${when}.` };
  if (d.blocked) return { tone: 'amber', title: would, detail: `${why}. Live control is off. ${when}.` };
  return { tone: 'amber', title: would, detail: `${why}. Log only, so nothing changed. ${when}.` };
}

/** The policy's thresholds in one sentence. */
export const policyRule = (policy, unit) =>
  `Delays ${policy.holdHours} h when rain reaches ${limit(policy.intensityMmH, unit)} ${unit}/h, today’s total reaches ${limit(policy.accumulationMm, unit)} ${unit}, or the next 12 hours forecast ${limit(policy.forecastMm, unit)} ${unit} at ${policy.forecastProbability}% or more. Missing readings never count as dry.`;
