// The Plan tab: what each zone needs, and the nights that follow from it.
// Advisory only. Edits save to the bridge's local store and never reach Tucor.
// Laid out for a phone first: a status line, a strip of nights, and a zone list.
// Each zone, the night window, and seasonal changes are edited in bottom sheets;
// anything that doesn't fit cleanly opens a review sheet before it saves.
//
//   state.js          the tab's state, drafts and the fourteen-night projection
//   draft.js          stage → check (/plan/edit-preview) → save (/plan/edit-apply)
//   page.js           status line, night strip, night card, zone rows
//   fit.js            the status line's words and the review sheet
//   zone-sheet.js     editing one zone
//   settings-sheet.js night window, zones at once, seasonal adjustment
//   programs.js       rebalance review and controller-program dry run
import { app } from '../core/app.js';
import { adjustedSeconds, cadenceLabel, currentNight, formatDuration } from '../../lib/planner.mjs';
import { nightLabel } from '../model/plan.js';
import * as fit from './fit.js';
import * as page from './page.js';
import * as programs from './programs.js';
import * as settingsSheet from './settings-sheet.js';
import * as zoneSheet from './zone-sheet.js';
import { blank, hooks, intents, plan, project, zones } from './state.js';

/** One line about a zone's plan, for the zone sheet on the Zones tab; null when there is no plan. */
function describeZone(id) {
  if (!app.state?.plan || !zones().some(z => z.id === id)) return null;
  const intent = { ...blank(), ...intents()[id] };
  const p = (plan.latest?.plan ?? project().plan).zones.find(z => z.id === id),
    start = plan.latest?.start ?? currentNight();
  if (p?.problem === 'paused') return 'Off for now';
  if (p?.problem) return 'Not planned yet · tap to set it up';
  return `${formatDuration(adjustedSeconds(intent))} · ${cadenceLabel(intent.cadence)} · next ${p.next < 0 ? 'later' : nightLabel(start, p.next).toLowerCase()}`;
}

/**
 * @param {{ zoneEnabled: (row: HTMLElement, off: boolean) => void }} options
 *   `zoneEnabled` dims a paused zone's row (from the water effects).
 */
export function mount({ zoneEnabled }) {
  hooks.render = page.render;
  hooks.openReview = fit.openReview;
  fit.mount();
  zoneSheet.mount();
  settingsSheet.mount();
  programs.mount();
  page.mount({ zoneEnabled, openZone: zoneSheet.openZone });
  return {
    render: () => app.tab === 'plan' && page.render(),
    openZone: zoneSheet.openZone,
    describeZone,
  };
}
