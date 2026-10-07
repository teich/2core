// The Plan tab's own state: unsaved edits and what the page is showing.
//
// Plan edits never reach Tucor. They are staged here as a draft (`plan.edit`,
// kept in sessionStorage so a reload doesn't lose it), checked by the server
// (/plan/edit-preview → `plan.review`) and saved with /plan/edit-apply. Until
// the server's state catches up, `plan.drafts` shows each zone's edited intent.
import { app } from '../core/app.js';
import { DEFAULT_INTENT, NIGHTS, addDays, currentNight, dateKey, resolvePlan, sunrise } from '../../lib/planner.mjs';
import { same } from '../model/plan.js';

const DRAFT_KEY = '2core-plan-draft';

export const plan = {
  /** Zone id → intent shown before the server confirms it. @type {Map<string, any>} */
  drafts: new Map(),
  /** The unsaved change, in the shape /plan/edit-preview takes. @type {any} */
  edit: {},
  /** The server's check of `edit` (assessment, alternatives, token). @type {any} */
  review: null,
  /** A check or save is in flight. */
  busy: false,
  /** Why the last check or save failed. */
  error: '',
  /** Night settings shown before the server confirms them. @type {any} */
  settingsDraft: null,
  /** The saved plan last checked, so it is checked again only when it changes. */
  checkedKey: '',
  /** Whether a draft from sessionStorage has been re-applied. */
  restored: false,
  /** Night selected in the strip, 0 = tonight. */
  night: 0,
  /** Show only zones that still need setting up. */
  needsOnly: false,
  /** Nights the person is trying as rainy ("What if it rains?"). @type {Set<string>} */
  whatIf: new Set(),
  /** The last resolved projection, for sheet summaries. @type {{ start: Date, plan: any, all: any } | null} */
  latest: null,
  /** The all-zones seasonal field was typed in and not yet applied. */
  seasonalEdited: false,
};

try {
  const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}');
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) plan.edit = saved;
} catch {
  /* ignore unavailable storage */
}

/** Persists the unsaved change for this tab, or clears it when empty. */
export function rememberDraft() {
  try {
    Object.keys(plan.edit).length
      ? sessionStorage.setItem(DRAFT_KEY, JSON.stringify(plan.edit))
      : sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* keep the in-memory draft */
  }
}

export const hasDraft = () => Object.keys(plan.edit).length > 0;
export const blank = () => ({ ...DEFAULT_INTENT });

/** Zones that exist on the controller, in order. */
export const zones = () => app.state.zones.filter(z => z.configured);
export const zoneName = id => zones().find(z => z.id === id)?.name ?? `Zone ${id}`;

/** Saved intents with drafts on top; drafts the server has caught up with are dropped. */
export function intents() {
  const saved = app.state.plan?.intents ?? {},
    out = { ...saved };
  for (const [id, draft] of plan.drafts) {
    if (same(saved[id], draft)) plan.drafts.delete(id);
    else out[id] = draft;
  }
  return out;
}

/** Saved night settings, or the draft until the server confirms it. */
export function settings() {
  const saved = app.state.plan?.settings;
  if (plan.settingsDraft && same(saved, plan.settingsDraft)) plan.settingsDraft = null;
  return plan.settingsDraft ?? saved;
}

/** A rain delay on the controller holds any night that starts before it ends. */
function rainNights(start, cfg) {
  const state = app.state,
    out = new Set(plan.whatIf);
  const left = Number(state.status?.rainShutDown),
    seen = Date.parse(state.observedAt);
  if (left > 0 && Number.isFinite(seen)) {
    const until = seen + left * 1000;
    for (let d = 0; d < NIGHTS; d++) {
      const evening = addDays(start, d);
      if (until > evening.getTime() + cfg.earliestStart * 60000) out.add(dateKey(evening));
    }
  }
  return out;
}

/** The next fourteen nights for these intents and settings. */
export function project(all = intents(), cfg = settings()) {
  const start = currentNight(),
    loc = app.state.location;
  const sunriseAt = loc ? date => sunrise(date, loc.latitude, loc.longitude) : () => null;
  return {
    start,
    plan: resolvePlan({ zones: zones(), intents: all, settings: cfg, start, rain: rainNights(start, cfg), sunriseAt }),
  };
}

/** Set by plan/index.js: re-render the whole tab, and open the review sheet. */
export const hooks = { render: () => {}, openReview: () => {} };
