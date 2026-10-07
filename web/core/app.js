// The one shared, mutable session for the web app, and the render/tick loop.
//
// - `app` holds everything that outlives a single render: the latest server
//   state plus UI selections. Views read it and change it only through actions
//   (core/commands.js) or their own selections (tab, selected zone, minutes…).
// - Views register `{ render, tick }`. `render()` runs after state or selection
//   changes; `tick(now)` runs every second for countdowns and may return a
//   partial frame for the water effects, which main.js collects.
//
// This module imports nothing, so any module may import it without cycles.

/**
 * @typedef {{ id: string, name: string, notes: string, order: number, configured: boolean,
 *   running: boolean, owned: boolean, favorite: boolean, startedAt?: string, endsAt?: string,
 *   minutes?: number, issues?: { issue: string, at: string }[] }} Zone
 * @typedef {{ id: string, kind: string, body: any, state: 'pending' | 'succeeded' | 'failed',
 *   phase?: string, acceptedAt?: string, deadline?: string, result?: any }} Operation
 * @typedef {{ id: string, kind?: string, body?: any, deadline: string, sentAt?: string, accepted: boolean }} Tracked
 *   A command this browser sent, remembered across reloads until its outcome is known.
 * @typedef {{ zone: string | null, action: string, message: string, at: number }} Failure
 * @typedef {{ zones: Zone[], operations?: Operation[], events: any[], status: any, available: boolean,
 *   controlEnabled: boolean, mode: string, observedAt?: string, connection?: any, limits?: any,
 *   policy: any, rain?: any, weatherSource?: any, weatherReading?: any, weatherDecision?: any,
 *   error?: string, plan?: any }} ServerState
 *   The body of GET /api/state; see server/engine.mjs `state()`.
 */

export const app = {
  /** Access key for the Bearer header; empty under Tailscale. */
  key: '',
  /** True when the Tailscale listener authenticates every request. */
  implicitAuth: false,
  /** @type {ServerState | null} */
  state: null,
  /** Whether the last /api/state request reached the server. */
  reachable: false,
  /** A request from this browser is in flight. */
  busy: false,
  /** @type {Tracked | null} */
  tracked: null,
  /** The latest failed command, shown briefly on its zone. @type {Failure | null} */
  failure: null,
  /** @type {'zones' | 'walk' | 'plan' | 'rain' | 'activity'} */
  tab: 'zones',
  /** Zone shown in the zone sheet. @type {string | null} */
  selected: null,
  /** Zone shown on the Walk view. @type {string | null} */
  walkId: null,
  /** Run length chosen on the zone sheet's dial. */
  minutes: 30,
  /** Run length for each zone on the Walk view. */
  walkMinutes: 1,
};

/** Inputs for the pure functions in model/: a snapshot of `app` at a moment. */
export const context = (now = Date.now()) => ({
  state: app.state,
  reachable: app.reachable,
  busy: app.busy,
  tracked: app.tracked,
  failure: app.failure,
  now,
});

/** @typedef {{ render?: () => void, tick?: (now: number) => object | void }} View */
/** @type {View[]} */
const views = [];
/** @type {((frame: object, now: number) => void)[]} */
const frameSinks = [];

/** @param {View} view */
export const register = view => void views.push(view);
/** Receives the merged frames returned by every view's tick. */
export const onFrame = fn => void frameSinks.push(fn);

export function render() {
  if (!app.state) return;
  for (const view of views) view.render?.();
  tick();
}

export function tick() {
  if (!app.state) return;
  const now = Date.now(),
    frame = {};
  for (const view of views) Object.assign(frame, view.tick?.(now));
  for (const sink of frameSinks) sink(frame, now);
}

/** @type {Map<string, Set<(detail: any) => void>>} */
const listeners = new Map();
/** Subscribes to an app event such as `loaded`, `load-failed` or `outcome`. */
export const on = (name, fn) => {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
};
export const emit = (name, detail) => listeners.get(name)?.forEach(fn => fn(detail));
