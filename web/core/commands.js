// Loading server state and sending commands.
//
// Commands are accepted by the server first (202 + operation) and confirmed
// later, so the phone can be locked in between. This browser remembers the
// command it sent (`app.tracked`, persisted) until the outcome is known, and
// never resends one automatically: an acknowledgement can be lost.
import { app, context, emit, render } from './app.js';
import { api, uuid } from './api.js';
import { message } from './message.js';
import { readJSON, write } from './storage.js';
import { blockedReason, controlsBusy, opTarget, operationLabel } from '../model/zones.js';

const COMMAND_KEY = '2core-command';
app.tracked = readJSON(COMMAND_KEY);

/** Tracks (or with `null`, forgets) this browser's in-flight command. */
export const remember = value => {
  app.tracked = value;
  write(COMMAND_KEY, value);
};

export const isBusy = () => controlsBusy(context());

let loading = false,
  pendingLoad = Promise.resolve(false);

/** Fetches /api/state and re-renders. Concurrent calls share one request. */
export function load() {
  if (!app.key && !app.implicitAuth) return Promise.resolve(false);
  if (loading) return pendingLoad;
  loading = true;
  pendingLoad = (async () => {
    try {
      app.state = await api('/state');
      app.reachable = true;
      await reconcileCommand();
      emit('loaded');
      render();
      return true;
    } catch (e) {
      app.reachable = false;
      if (!app.state) emit('load-failed', e.message);
      else {
        app.state.available = false;
        render();
        message(
          app.tracked
            ? 'Connection interrupted. Your request may still be running. Reopen the app to check; it will not be sent again.'
            : e.status
              ? e.message
              : 'Can’t reach the garden server. Trying again every few seconds.',
          true,
        );
      }
      return false;
    } finally {
      loading = false;
    }
  })();
  return pendingLoad;
}

/** Matches the tracked command with the server's record and reports its outcome once. */
async function reconcileCommand() {
  const { state } = app;
  if (!app.tracked) {
    const pending = state.operations?.find(o => o.state === 'pending');
    if (pending) remember({ id: pending.id, deadline: pending.deadline, accepted: true });
  }
  const tracked = app.tracked;
  let operation = tracked && state.operations?.find(o => o.id === tracked.id);
  if (tracked && !operation) {
    try {
      operation = (await api(`/commands/${tracked.id}`)).operation;
    } catch (error) {
      if (error.status !== 404) throw error;
      // An acknowledgement can be lost. Never send the request again automatically.
      if (Date.now() > Date.parse(tracked.deadline)) {
        remember(null);
        message('The request was not accepted before its deadline. Check the controller before trying again.', true);
      }
    }
  }
  const target = opTarget(operation);
  if (operation?.state === 'succeeded') {
    const run = operation.result?.run;
    if (run) app.walkId = run.zone;
    remember(null);
    message(`Confirmed: ${operationLabel(operation, state.zones)}.`);
    if (target) emit('outcome', target.action === 'start' ? 'started' : 'stopped');
  } else if (operation?.state === 'failed') {
    remember(null);
    const reason = operation.result?.error || 'Not confirmed. Check the controller before trying again.';
    message(`${operationLabel(operation, state.zones)}: ${reason}`, true);
    if (target) {
      app.failure = { zone: target.zone, action: target.action, message: reason, at: Date.now() };
      emit('outcome', 'failed');
    }
  } else if (operation) {
    remember({ ...tracked, accepted: true });
  }
}

/** Keeps the banner describing the command in progress. Called on every render. */
export function showPending() {
  const operation = app.state?.operations?.find(o => o.state === 'pending');
  if (operation) {
    const phase =
      operation.phase === 'confirming'
        ? 'Waiting for confirmation.'
        : operation.phase === 'queued'
          ? 'Waiting its turn.'
          : 'Connecting and checking the controller.';
    message(`Accepted: ${operationLabel(operation, app.state.zones)}. ${phase} You can lock your phone.`);
  } else if (app.tracked) {
    message(
      app.tracked.accepted
        ? 'Accepted. The server is handling it; you can lock your phone.'
        : 'Checking whether your request was accepted. It will not be sent again automatically.',
    );
  }
}

/**
 * Sends a command (a POST under /api) unless another is still being handled.
 * `/refresh` is special: it only asks the server to check the controller.
 * @returns {Promise<boolean>} whether the server accepted it.
 */
export async function act(path, body = {}, label = 'Sending request…') {
  if (isBusy()) return false;
  app.busy = true;
  message(label);
  render();
  if (path === '/refresh') {
    try {
      lastPrepare = Date.now();
      await api('/prepare', {});
      message('Checking the controller in the background…');
      return true;
    } catch (e) {
      message(e.message, true);
      return false;
    } finally {
      app.busy = false;
      render();
    }
  }
  const request = {
    id: uuid(),
    kind: `/api${path}`,
    body,
    deadline: new Date(Date.now() + 60000).toISOString(),
    sentAt: new Date().toISOString(),
    accepted: false,
  };
  remember(request);
  try {
    const result = await api(path, body, { ...request, async: true });
    remember({ ...request, accepted: true });
    if (result.operation) {
      app.state.operations = [
        result.operation,
        ...(app.state.operations || []).filter(o => o.id !== result.operation.id),
      ];
      await reconcileCommand();
    }
    showPending();
    // Status polling is independent of this tap and survives closing/reopening.
    load();
    return true;
  } catch (e) {
    if (e.status) remember(null);
    message(
      e.status
        ? e.message
        : 'Could not confirm acceptance. Checking status; this request will not be sent again automatically.',
      true,
    );
    load();
    return false;
  } finally {
    app.busy = false;
    render();
  }
}

/** Polls until no command is pending, for actions that send several in a row. */
export async function waitUntilIdle(limit = 15000) {
  const until = Date.now() + limit;
  while (isBusy() && Date.now() < until) {
    await new Promise(r => setTimeout(r, 400));
    await load();
  }
  return !isBusy();
}

// Tucor is only contacted while someone is actually using the app: on open, on
// interaction after a pause, and once a minute during active use. Left open and
// untouched, the app stops asking and the server releases the controller.
export const ACTIVE_MS = 10 * 60000,
  HEARTBEAT_MS = 60000;
let lastInteraction = Date.now(),
  lastPrepare = 0;

/** Asks the server to open a controller session, at most every 20 s unless forced. */
export function prepare(force = false) {
  if (!(app.key || app.implicitAuth) || (!force && Date.now() - lastPrepare < 20000)) return;
  lastPrepare = Date.now();
  api('/prepare', {}).catch(() => {});
}

/** Records a tap or key press; the first after a pause reopens the session. */
export function interacted() {
  const paused = Date.now() - lastInteraction > HEARTBEAT_MS;
  lastInteraction = Date.now();
  if (paused) prepare();
}

/** The page became visible again: treat it as fresh use. */
export function resumed() {
  lastInteraction = Date.now();
  prepare();
  load();
}

/** Once a minute: keep the session open while the app is in active use. */
export function heartbeat() {
  if (!document.hidden && Date.now() - lastInteraction < ACTIVE_MS) prepare();
}

/** Starts a timed run unless something blocks it (see model/zones.js `blockedReason`). */
export async function startZone(id, minutes) {
  if (blockedReason(context())) return;
  app.walkId = id;
  await act(`/zones/${id}/start`, { minutes });
}
