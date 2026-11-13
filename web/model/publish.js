// Words for publishing the saved plan to the controller. Pure; the server's
// lib/publish.mjs works out what changes.
import { cadenceLabel, formatDuration, fromKey } from '../../lib/planner.mjs';
import { WD, MONTH, clockAt } from './plan.js';

const SETTINGS = {
  earliestStart: ['Start after', clockAt],
  finishBeforeSunrise: ['Finish before sunrise by', m => `${m} min`],
  hardDeadline: ['Never past', clockAt],
  lanes: ['Zones at once', n => String(n)],
};

/** One edit to a zone's intention as words. */
function fieldText({ field, before, after }) {
  if (field === 'seconds') return `${formatDuration(before)} → ${formatDuration(after)}`;
  if (field === 'cadence') return `${cadenceLabel(before)} → ${cadenceLabel(after).toLowerCase()}`;
  if (field === 'enabled') return after ? 'Turned on' : 'Turned off for now';
  if (field === 'seasonalPercent') return `Seasonal ${before}% → ${after}%`;
  if (field === 'firstDue') return 'Watering dates moved';
  return field;
}

/**
 * The edits since the last publish, one line per zone or setting.
 * @param {{ zones: any[], settings: any[] }} edits From the state's `publish.edits`.
 * @param {Record<string, string>} names Zone names by id.
 * @param {Record<string, any>} intents The saved intentions, for zones newly planned.
 * @returns {{ title: string, detail: string }[]}
 */
export function editLines(edits, names, intents = {}) {
  const name = id => names[id] ?? `Zone ${id}`;
  const zones = edits.zones.map(z => {
    if (z.added) {
      const i = intents[z.zone] ?? {};
      return {
        title: name(z.zone),
        detail: `Now planned: ${formatDuration(i.seconds ?? 0)}, ${cadenceLabel(i.cadence).toLowerCase()}`,
      };
    }
    if (z.removed) return { title: name(z.zone), detail: 'No longer planned' };
    // A new cadence moves the dates by itself; saying so again is noise.
    const fields = z.fields.some(f => f.field === 'cadence') ? z.fields.filter(f => f.field !== 'firstDue') : z.fields;
    return { title: name(z.zone), detail: fields.map(fieldText).join(' · ') };
  });
  const settings = edits.settings.map(({ field, before, after }) => {
    const [label, show] = SETTINGS[field] ?? [field, String];
    return { title: label, detail: `${show(before)} → ${show(after)}` };
  });
  return [...settings, ...zones];
}

/** How many edits, as `3 changes`. */
export const editCount = edits => {
  const n = edits ? edits.zones.length + edits.settings.length : 0;
  return `${n} change${n === 1 ? '' : 's'}`;
};

/** `Fri Nov 14` for a night `YYYY-MM-DD`. */
const nightName = key => {
  const d = fromKey(key);
  return `${WD[d.getDay()]} ${MONTH[d.getMonth()]} ${d.getDate()}`;
};
const span = n => (n.start == null ? 'nothing' : `${clockAt(n.start)}–${clockAt(n.finish)}`);

/**
 * The nights that publishing changes: what's added, dropped, and when it finishes.
 * @param {{ nights: any[] }} impact @param {Record<string, string>} names
 */
export function nightLines(impact, names) {
  const name = id => names[id] ?? `Zone ${id}`;
  return impact.nights
    .filter(n => n.changed)
    .map(n => {
      const added = n.after.zones.filter(z => !n.before.zones.includes(z)).map(name),
        dropped = n.before.zones.filter(z => !n.after.zones.includes(z)).map(name);
      const parts = [];
      if (added.length) parts.push(`adds ${added.join(', ')}`);
      if (dropped.length) parts.push(`drops ${dropped.join(', ')}`);
      parts.push(span(n.before) === span(n.after) ? `${span(n.after)}` : `${span(n.before)} → ${span(n.after)}`);
      return { title: nightName(n.night), detail: parts.join(' · ') };
    });
}

/** Zones whose minutes a week change. @param {{ zones: any[] }} impact @param {Record<string, string>} names */
export const minuteLines = (impact, names) =>
  impact.zones
    .filter(z => z.before !== z.after)
    .map(z => ({ title: names[z.zone] ?? `Zone ${z.zone}`, detail: `${z.before} → ${z.after} min a week` }));

const time = iso => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** When tonight's watering stops a publish, as a sentence, or '' when it doesn't matter now. */
export function windowNote(window, now = Date.now()) {
  if (!window?.closesAt) return '';
  if (!window.open) return `Tonight’s watering is due or under way. Publishing opens again at ${time(window.opensAt)}.`;
  const closes = Date.parse(window.closesAt);
  return closes > now ? `Publish before ${time(window.closesAt)} for it to take effect tonight.` : '';
}

/**
 * The bar at the top of the Plan tab: `{ title, detail, tone, action }`, or
 * null to hide it. `action` is the button's words.
 * @param {any} publish The state's `publish`.
 * @param {(iso: string) => string} day `Oct 28`-style date.
 */
export function publishBar(publish, day) {
  if (!publish) return null;
  const count = publish.edits ? publish.edits.zones.length + publish.edits.settings.length : 0;
  if (publish.state === 'matches')
    return {
      title: 'On the controller',
      detail: publish.since ? `Published ${day(publish.since)}` : 'The controller runs the saved plan',
      tone: 'ok',
      action: 'Details',
    };
  if (publish.state === 'plan changed')
    return {
      title: count ? `${editCount(publish.edits)} not published` : 'Not on the controller',
      detail: count && publish.since ? `Last published ${day(publish.since)}` : publish.message,
      tone: 'draft',
      action: 'Review and publish',
    };
  if (publish.state === 'controller changed')
    return { title: 'Programs changed outside 2core', detail: publish.message, tone: 'bad', action: 'Review' };
  return { title: 'Not checked yet', detail: publish.message, tone: '', action: 'Review' };
}
