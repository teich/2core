// What each zone is doing, as far as the controller has confirmed, and what the
// person may do next. Pure functions of a context from core/app.js `context()`.
import { at, clock, duration } from '../core/format.js';

/** @typedef {ReturnType<typeof import('../core/app.js').context>} Context */
/** @typedef {import('../core/app.js').Zone} Zone */

export const ISSUES = [
  'Leak',
  'Broken head',
  'Misaligned head',
  'Clogged or weak',
  'Overspray',
  'Dry spot',
  'Valve won’t close',
  'Other',
];

const PHASE = {
  queued: 'Waiting its turn',
  connecting: 'Reaching the controller',
  sending: 'Sending',
  confirming: 'Waiting for confirmation',
};

export const limitsOf = state => state?.limits ?? { minMinutes: 1, maxMinutes: 240 };

export const runningZones = state => state?.zones.filter(z => z.running) || [];

/** The server's pending operation, else the one this browser is still tracking. */
export const pendingCommand = ({ state, tracked }) => state?.operations?.find(o => o.state === 'pending') || tracked;

export const controlsBusy = ctx => ctx.busy || Boolean(pendingCommand(ctx));

export const canControl = ctx => ctx.reachable && ctx.state?.controlEnabled && !controlsBusy(ctx);

/** Why a new run can't start right now, or '' when it can. */
export function blockedReason(ctx) {
  const { state } = ctx;
  if (!ctx.reachable) return 'Can’t reach the garden server.';
  if (!state.controlEnabled) return 'Read-only. Watering is turned off on the server.';
  if (controlsBusy(ctx)) return 'Your last request is still being handled. You can lock your phone.';
  if (state.available && Number(state.status.rainShutDown) > 0)
    return 'Rain delay is on. Clear it in Weather to water.';
  if (state.available && runningZones(state).length) return 'Another zone is running. Stop it first.';
  return '';
}

/** Which zone an operation acts on, and whether it starts or stops it. */
export function opTarget(op) {
  const match = op?.kind?.match(/zones\/(\d+)\/(start|next|stop)/);
  if (match) return { zone: match[1], action: match[2] === 'stop' ? 'stop' : 'start', next: match[2] === 'next' };
  if (op?.kind === '/api/stop') return { zone: null, action: 'stop', next: false };
  return null;
}

/** The operation in progress, including one this browser sent that the server hasn't listed yet. */
export function pendingOp({ state, tracked, now }) {
  const op = state?.operations?.find(o => o.state === 'pending');
  if (op) return op;
  if (tracked?.kind && !state?.operations?.some(o => o.id === tracked.id))
    return {
      kind: tracked.kind,
      body: tracked.body || {},
      phase: tracked.accepted ? 'queued' : 'sending',
      acceptedAt: tracked.sentAt || new Date(now).toISOString(),
    };
  return null;
}

/**
 * @param {Zone | undefined} z
 * @param {Context} ctx
 * @returns {'idle' | 'offline' | 'starting' | 'stopping' | 'failed' | 'stale' | 'running' | 'unknown'}
 */
export function zoneMode(z, ctx) {
  if (!z) return 'idle';
  if (!ctx.reachable) return 'offline';
  const target = opTarget(pendingOp(ctx));
  if (target) {
    if (target.action === 'start' && target.zone === z.id) return 'starting';
    if (target.action === 'stop' && (target.zone === z.id || (target.zone === null && z.running))) return 'stopping';
    if (target.next && z.running && z.owned) return 'stopping';
  }
  if (ctx.failure?.zone === z.id && ctx.now - ctx.failure.at < 6000) return 'failed';
  if (!ctx.state.available) return 'stale';
  if (z.running) return z.owned && z.startedAt && z.minutes && z.endsAt ? 'running' : 'unknown';
  return 'idle';
}

/** Share of a run still to go; 0.5 when the end time is unknown. */
const fraction = (z, now) =>
  z.endsAt && z.minutes ? Math.max(0, Math.min(1, (Date.parse(z.endsAt) - now) / (z.minutes * 60000))) : 0.5;

/** How full a zone's water vessel should look. */
export function levelOf(z, mode, now) {
  if (mode === 'running') return fraction(z, now);
  if (mode === 'unknown') return 0.5; // Never invent progress for a run we don't own.
  if ((mode === 'stopping' || mode === 'stale' || mode === 'offline') && z.running) return fraction(z, now);
  return 0;
}

export const waitText = (op, now) =>
  `${PHASE[op?.phase] || 'Sending'} · ${Math.max(0, Math.round((now - Date.parse(op?.acceptedAt)) / 1000)) || 0} s`;

/**
 * Status text for a zone in a mode: `text` is a sentence, `short` fits a
 * capsule, `cls` styles the status line and `tone` colors the water.
 * @param {Zone} z
 * @param {ReturnType<typeof zoneMode>} mode
 * @param {Context} ctx
 */
export function describe(z, mode, ctx) {
  const { now, failure, state } = ctx;
  switch (mode) {
    case 'starting':
      return { text: waitText(pendingOp(ctx), now), cls: 'wait', short: 'Starting', tone: 'water' };
    case 'stopping':
      return { text: `Stopping · ${waitText(pendingOp(ctx), now)}`, cls: 'wait', short: 'Stopping', tone: 'water' };
    case 'running':
      return {
        text: `Watering · ends ${at(Date.parse(z.endsAt))}`,
        cls: 'live',
        short: clock(Date.parse(z.endsAt) - now),
        tone: 'water',
      };
    case 'unknown':
      return {
        text: z.owned ? 'Watering · end time unknown' : 'Watering · started at the controller',
        cls: 'live',
        short: 'Watering',
        tone: 'water',
      };
    case 'failed':
      return {
        text: `Didn’t ${failure.action}: ${failure.message}`,
        cls: 'fail',
        short: `Didn’t ${failure.action}`,
        tone: 'amber',
      };
    case 'stale':
      return {
        text: state.observedAt ? `Last checked at ${at(Date.parse(state.observedAt))}` : 'Not checked yet',
        cls: 'stale',
        short: 'Not live',
        tone: 'idle',
      };
    case 'offline':
      return { text: 'Can’t reach the garden server', cls: 'stale', short: 'Offline', tone: 'idle' };
    default:
      return { text: '', cls: '', short: 'Ready', tone: 'idle' };
  }
}

/** The latest confirmed run of each zone, from the server's event log. */
export function lastRuns(events = []) {
  const out = {};
  for (const e of events) {
    const m = e.kind.match(/zones\/(\d+)\/(start|next)$/);
    if (m && e.data.outcome === 'confirmed' && !out[m[1]]) out[m[1]] = { at: e.at, minutes: e.data.minutes };
  }
  return out;
}

/** A short description of what an operation asked for, for status messages. */
export function operationLabel(operation, zones = []) {
  const match = operation.kind?.match(/zones\/(\d+)\/(start|next|stop)/);
  const name = match && (zones.find(z => z.id === match[1])?.name || `zone ${match[1]}`);
  if (match)
    return match[2] === 'stop'
      ? `Stop ${name}`
      : `${match[2] === 'next' ? 'Stop and start' : 'Start'} ${name} for ${duration(operation.body.minutes)}`;
  if (operation.kind === '/api/rain')
    return operation.body.hours ? `Rain delay for ${operation.body.hours} hours` : 'Clear rain delay';
  if (operation.kind === '/api/stop') return 'Stop watering';
  if (operation.body?.issues) return 'Save flag';
  return 'Save changes';
}

/** A search matches a zone number (leading zeros optional) or any part of its name or notes. */
export const zoneMatches = (z, query) => {
  const q = query.trim().toLowerCase();
  return !q || z.id === q.replace(/^0+/, '') || `${z.name} ${z.notes}`.toLowerCase().includes(q);
};

/** Zones for the Zones list under its search and filter chips. */
export const filterZones = (zones, { query = '', showUnused = false, favorites = false, flagged = false }) =>
  zones.filter(
    z =>
      (z.configured || showUnused) &&
      (!favorites || z.favorite) &&
      (!flagged || z.issues?.length) &&
      zoneMatches(z, query),
  );

/** Zones in walking order. */
export const walkZones = (zones, showUnused = false) => zones.filter(z => z.configured || showUnused);

/** The zone after `currentId`, wrapping around. */
export const nextZone = (zones, currentId) => zones[(zones.findIndex(z => z.id === currentId) + 1) % zones.length];

/** Dial positions: every minute for the first hour, then five-minute steps. */
export const dialSteps = limits => {
  const out = [];
  for (let m = limits.minMinutes; m <= limits.maxMinutes; m += m < 60 ? 1 : 5) out.push(m);
  return out;
};

/** Index of the dial step closest to `m` minutes. */
export const stepIndex = (steps, m) => {
  let best = 0;
  steps.forEach((s, i) => {
    if (Math.abs(s - m) < Math.abs(steps[best] - m)) best = i;
  });
  return best;
};
