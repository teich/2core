// How live the view of the controller is. Pure; see core/app.js `context()`.
import { ago, at } from '../core/format.js';

/** The header pill: `[text, tone]`. */
export function connectionStatus({ state, reachable, now }) {
  const c = state.connection || {};
  if (!reachable) return ['Offline', 'bad'];
  if (state.mode === 'demo') return ['Simulation', ''];
  if (c.checking) return ['Checking controller', 'stale'];
  if (state.available) return [`${c.open ? 'Connected' : 'Checked'} · ${ago(state.observedAt, now)}`, ''];
  if (c.retryAt) return ['Retrying later · tap for details', 'bad'];
  if (state.error) return ['Controller unreachable', 'bad'];
  return [state.observedAt ? `Paused · checked ${ago(state.observedAt, now)}` : 'Paused · tap to check', 'stale'];
}

/** Why 2core is or isn't talking to Tucor, for the Activity view. */
export const tucorNote = connection =>
  connection?.retryAt
    ? `After a failed connection, 2core waits until ${at(Date.parse(connection.retryAt))} before connecting on its own. Your commands can still retry.`
    : connection?.lastError
      ? `Last problem: ${connection.lastError}`
      : '2core only connects while you use the app or when a rain delay needs setting.';
