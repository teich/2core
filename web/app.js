import { createWaterFX } from './water.js';
import { createPlan } from './plan.js';
const $ = id => document.getElementById(id);
const implicitAuth = await import('./auth.js').then(m => m.detectImplicitAuthentication()).catch(() => false);
let key = sessionStorage.getItem('2core-key') || '';
let state, busy = false, loading = false, pendingLoad, editing, selected, walkId, flagZone, tab = 'zones';
let reachable = false, tracked, failure = null, clearArmed = false, messageTimer, railShown;
const stored = (name, fallback) => { try { return Number(localStorage.getItem(name)) || fallback; } catch { return fallback; } };
const store = (name, value) => { try { localStorage.setItem(name, String(value)); } catch { /* convenience only */ } };
let minutes = stored('2core-minutes', 30), walkMinutes = stored('2core-walk-minutes', 1), motionEnabled = false;
try { motionEnabled = localStorage.getItem('2core-motion-enabled') === 'true'; } catch { /* use the default */ }
try { tracked = JSON.parse(localStorage.getItem('2core-command') || 'null'); } catch { /* old or unavailable storage */ }
const remember = value => {
  tracked = value;
  try { value ? localStorage.setItem('2core-command', JSON.stringify(value)) : localStorage.removeItem('2core-command'); } catch { /* server still retains status */ }
};
const pendingCommand = () => state?.operations?.find(o => o.state === 'pending') || tracked;
const controlsBusy = () => busy || Boolean(pendingCommand());
const waterFX = createWaterFX();
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const uuid = () => globalThis.crypto?.randomUUID ? crypto.randomUUID() : `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const runningZones = () => state?.zones.filter(z => z.running) || [];
const canControl = () => reachable && state?.controlEnabled && !controlsBusy();
const isPressed = id => $(id).getAttribute('aria-pressed') === 'true';
const pad = id => String(id).padStart(2, '0');
const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const limits = () => state?.limits ?? { minMinutes: 1, maxMinutes: 240 };
// Dial positions: every minute for the first hour, then five-minute steps.
const dialSteps = () => { const max = limits().maxMinutes, out = []; for (let m = limits().minMinutes; m <= max; m += m < 60 ? 1 : 5) out.push(m); return out; };
const stepIndex = m => { const steps = dialSteps(); let best = 0; steps.forEach((s, i) => { if (Math.abs(s - m) < Math.abs(steps[best] - m)) best = i; }); return best; };
const snap = m => dialSteps()[stepIndex(m)];
const hm = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
const duration = m => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
const ISSUES = ['Leak', 'Broken head', 'Misaligned head', 'Clogged or weak', 'Overspray', 'Dry spot', 'Valve won’t close', 'Other'];
const PHASE = { queued: 'Waiting its turn', connecting: 'Reaching the controller', sending: 'Sending', confirming: 'Waiting for confirmation' };
const visibleZones = () => state.zones.filter(z => (z.configured || isPressed('show-unused')) && (!isPressed('favorites') || z.favorite) && (!isPressed('flagged') || z.issues?.length) && matches(z));
const matches = z => { const q = $('search').value.trim().toLowerCase(); return !q || z.id === q.replace(/^0+/, '') || `${z.name} ${z.notes}`.toLowerCase().includes(q); };
const walkZones = () => state.zones.filter(z => z.configured || isPressed('show-unused'));
const getWalkZone = () => walkZones().find(z => z.id === walkId) || walkZones().find(z => z.running) || walkZones()[0];

/* ---------- time ---------- */
const clock = ms => { const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`; };
const at = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const ago = iso => { const s = (Date.now() - Date.parse(iso)) / 1000; if (!Number.isFinite(s)) return 'never'; if (s < 60) return `${Math.max(1, Math.round(s))} s ago`; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }); };
const day = iso => { const d = new Date(iso), diff = Math.round((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 864e5); return diff === 0 ? 'today' : diff === 1 ? 'yesterday' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };

function html(id, value) {
  const el = $(id);
  // Polling must not detach a focused control when nothing changed.
  if (el._html === value) return;
  const focused = el.contains(document.activeElement) ? document.activeElement?.dataset : null;
  const focusId = focused?.zone || focused?.walk;
  el.innerHTML = value; el._html = value;
  if (focusId) [...el.querySelectorAll('button')].find(b => (b.dataset.zone || b.dataset.walk) === focusId)?.focus({ preventScroll:true });
}
function message(text, error = false) {
  clearTimeout(messageTimer);
  $('message').hidden = !text; $('message').textContent = text; $('message').className = error ? 'error' : '';
  $('sheet-feedback').textContent = text; $('sheet-feedback').className = error ? 'failure' : '';
  // Confirmations fade on their own; errors stay until something replaces them.
  if (text && !error && !pendingCommand()) messageTimer = setTimeout(() => { if (!pendingCommand()) message(''); }, 6000);
}
async function api(path, body, options = {}) {
  const response = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': options.id || uuid(), ...(options.async ? { Prefer:'respond-async' } : {}) } : {}) },
    body: body ? JSON.stringify({ ...body, deadline: options.deadline || new Date(Date.now() + 60000).toISOString() }) : undefined,
    signal: AbortSignal.timeout(options.async ? 15000 : 90000),
    keepalive: Boolean(options.async),
  });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'Request failed'); error.status = response.status; throw error; }
  return data;
}
async function load() {
  if (!key && !implicitAuth) return false;
  if (loading) return pendingLoad;
  loading = true;
  let resolveLoad;
  pendingLoad = new Promise(resolve => { resolveLoad = resolve; });
  try {
    state = await api('/state');
    reachable = true;
    await reconcileCommand();
    $('login').hidden = true; $('application').hidden = false; $('dock').hidden = false; $('signout').hidden = implicitAuth; $('login-error').textContent = '';
    render(); return true;
  } catch (e) {
    reachable = false;
    if (!state) $('login-error').textContent = e.message;
    else { state.available = false; render(); message(tracked ? 'Connection interrupted. Your request may still be running. Reopen the app to check; it will not be sent again.' : e.status ? e.message : 'Can’t reach the garden server. Trying again every few seconds.', true); }
    return false;
  } finally { loading = false; resolveLoad(); }
}
function operationLabel(operation) {
  const match = operation.kind?.match(/zones\/(\d+)\/(start|next|stop)/);
  const name = match && (state?.zones.find(z => z.id === match[1])?.name || `zone ${match[1]}`);
  if (match) return match[2] === 'stop' ? `Stop ${name}` : `${match[2] === 'next' ? 'Stop and start' : 'Start'} ${name} for ${duration(operation.body.minutes)}`;
  if (operation.kind === '/api/rain') return operation.body.hours ? `Rain delay for ${operation.body.hours} hours` : 'Clear rain delay';
  if (operation.kind === '/api/stop') return 'Stop watering';
  if (operation.body?.issues) return 'Save flag';
  return 'Save changes';
}
function opTarget(op) {
  const match = op?.kind?.match(/zones\/(\d+)\/(start|next|stop)/);
  if (match) return { zone: match[1], action: match[2] === 'stop' ? 'stop' : 'start', next: match[2] === 'next' };
  if (op?.kind === '/api/stop') return { zone: null, action: 'stop' };
  return null;
}
async function reconcileCommand() {
  if (!tracked) {
    const pending = state.operations?.find(o => o.state === 'pending');
    if (pending) remember({ id:pending.id, deadline:pending.deadline, accepted:true });
  }
  let operation = tracked && state.operations?.find(o => o.id === tracked.id);
  if (tracked && !operation) {
    try { operation = (await api(`/commands/${tracked.id}`)).operation; }
    catch (error) {
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
    if (run) walkId = run.zone;
    remember(null);
    message(`Confirmed: ${operationLabel(operation)}.`);
    if (target) waterFX.event(target.action === 'start' ? 'started' : 'stopped');
  } else if (operation?.state === 'failed') {
    remember(null);
    const reason = operation.result?.error || 'Not confirmed. Check the controller before trying again.';
    message(`${operationLabel(operation)}: ${reason}`, true);
    if (target) { failure = { zone: target.zone, action: target.action, message: reason, at: Date.now() }; waterFX.event('failed'); }
  } else if (operation) {
    remember({ ...tracked, accepted:true });
  }
}
function showPending() {
  const operation = state?.operations?.find(o => o.state === 'pending');
  if (operation) {
    const phase = operation.phase === 'confirming' ? 'Waiting for confirmation.' : operation.phase === 'queued' ? 'Waiting its turn.' : 'Connecting and checking the controller.';
    message(`Accepted: ${operationLabel(operation)}. ${phase} You can lock your phone.`);
  } else if (tracked) {
    message(tracked.accepted ? 'Accepted. The server is handling it; you can lock your phone.' : 'Checking whether your request was accepted. It will not be sent again automatically.');
  }
}
async function act(path, body = {}, label = 'Sending request…') {
  if (controlsBusy()) return false;
  busy = true; message(label); render();
  if (path === '/refresh') {
    try { lastPrepare = Date.now(); await api('/prepare', {}); message('Checking the controller in the background…'); return true; }
    catch (e) { message(e.message, true); return false; }
    finally { busy = false; render(); }
  }
  const request = { id:uuid(), kind:`/api${path}`, body, deadline:new Date(Date.now() + 60000).toISOString(), sentAt:new Date().toISOString(), accepted:false };
  remember(request);
  try {
    const result = await api(path, body, { ...request, async:true });
    remember({ ...request, accepted:true });
    if (result.operation) {
      state.operations = [result.operation, ...(state.operations || []).filter(o => o.id !== result.operation.id)];
      await reconcileCommand();
    }
    showPending();
    // Status polling is independent of this tap and survives closing/reopening.
    load();
    return true;
  } catch (e) {
    if (e.status) remember(null);
    message(e.status ? e.message : 'Could not confirm acceptance. Checking status; this request will not be sent again automatically.', true);
    load(); return false;
  } finally { busy = false; render(); }
}
// Tucor is only contacted while someone is actually using the app: on open, on
// interaction after a pause, and once a minute during active use. Left open and
// untouched, the app stops asking and the server releases the controller.
const ACTIVE_MS = 10 * 60000, HEARTBEAT_MS = 60000;
let lastInteraction = Date.now(), lastPrepare = 0;
function prepare(force = false) {
  if (!(key || implicitAuth) || (!force && Date.now() - lastPrepare < 20000)) return;
  lastPrepare = Date.now();
  api('/prepare', {}).catch(() => {});
}
function interacted() {
  const paused = Date.now() - lastInteraction > HEARTBEAT_MS;
  lastInteraction = Date.now();
  if (paused) prepare();
}
function blockedReason() {
  if (!reachable) return 'Can’t reach the garden server.';
  if (!state.controlEnabled) return 'Read-only. Watering is turned off on the server.';
  if (controlsBusy()) return 'Your last request is still being handled. You can lock your phone.';
  if (state.available && Number(state.status.rainShutDown) > 0) return 'Rain delay is on. Clear it in Weather to water.';
  if (state.available && runningZones().length) return 'Another zone is running. Stop it first.';
  return '';
}

/* ---------- what each zone is doing, as far as the controller has confirmed ---------- */
function pendingOp() {
  const op = state?.operations?.find(o => o.state === 'pending');
  if (op) return op;
  if (tracked?.kind && !state?.operations?.some(o => o.id === tracked.id)) return { kind: tracked.kind, body: tracked.body || {}, phase: tracked.accepted ? 'queued' : 'sending', acceptedAt: tracked.sentAt || new Date().toISOString() };
  return null;
}
function zoneMode(z) {
  if (!z) return 'idle';
  if (!reachable) return 'offline';
  const op = pendingOp(), target = opTarget(op);
  if (target) {
    if (target.action === 'start' && target.zone === z.id) return 'starting';
    if (target.action === 'stop' && (target.zone === z.id || (target.zone === null && z.running))) return 'stopping';
    if (target.next && z.running && z.owned) return 'stopping';
  }
  if (failure?.zone === z.id && Date.now() - failure.at < 6000) return 'failed';
  if (!state.available) return 'stale';
  if (z.running) return z.owned && z.startedAt && z.minutes && z.endsAt ? 'running' : 'unknown';
  return 'idle';
}
const fraction = z => z.endsAt && z.minutes ? Math.max(0, Math.min(1, (Date.parse(z.endsAt) - Date.now()) / (z.minutes * 60000))) : 0.5;
function levelOf(z, mode) {
  if (mode === 'running') return fraction(z);
  if (mode === 'unknown') return 0.5;          // Never invent progress for a run we don't own.
  if ((mode === 'stopping' || mode === 'stale' || mode === 'offline') && z.running) return fraction(z);
  return 0;
}
const waitText = op => `${PHASE[op?.phase] || 'Sending'} · ${Math.max(0, Math.round((Date.now() - Date.parse(op?.acceptedAt)) / 1000)) || 0} s`;
function describe(z, mode) {
  switch (mode) {
    case 'starting': return { text: waitText(pendingOp()), cls: 'wait', short: 'Starting', tone: 'water' };
    case 'stopping': return { text: `Stopping · ${waitText(pendingOp())}`, cls: 'wait', short: 'Stopping', tone: 'water' };
    case 'running': return { text: `Watering · ends ${at(Date.parse(z.endsAt))}`, cls: 'live', short: clock(Date.parse(z.endsAt) - Date.now()), tone: 'water' };
    case 'unknown': return { text: z.owned ? 'Watering · end time unknown' : 'Watering · started at the controller', cls: 'live', short: 'Watering', tone: 'water' };
    case 'failed': return { text: `Didn’t ${failure.action}: ${failure.message}`, cls: 'fail', short: `Didn’t ${failure.action}`, tone: 'amber' };
    case 'stale': return { text: state.observedAt ? `Last checked at ${at(Date.parse(state.observedAt))}` : 'Not checked yet', cls: 'stale', short: 'Not live', tone: 'idle' };
    case 'offline': return { text: 'Can’t reach the garden server', cls: 'stale', short: 'Offline', tone: 'idle' };
    default: return { text: '', cls: '', short: 'Ready', tone: 'idle' };
  }
}
function lastRuns() {
  const out = {};
  for (const e of state.events || []) {
    const m = e.kind.match(/zones\/(\d+)\/(start|next)$/);
    if (m && e.data.outcome === 'confirmed' && !out[m[1]]) out[m[1]] = { at: e.at, minutes: e.data.minutes };
  }
  return out;
}

/* ---------- rendering ---------- */
function showTab(name) {
  tab = name; railShown = null; document.body.dataset.view = name;
  const titles = { zones:'Zones', walk:'Walk', plan:'Watering plan', rain:'Weather', activity:'Activity' };
  $('view-title').textContent = titles[name];
  document.querySelectorAll('[data-tab]').forEach(b => b.dataset.tab === name ? b.setAttribute('aria-current','page') : b.removeAttribute('aria-current'));
  for (const view of Object.keys(titles)) $(`${view}-view`).hidden = view !== name;
  window.scrollTo({ top:0, behavior:'instant' });
  render();
}
function openZone(id) {
  selected = id; $('sheet-feedback').textContent = ''; renderSheet();
  $('zone-dialog').showModal();
  requestAnimationFrame(() => setDial(minutes, false));
  tick();
}
function buildDial() {
  const max = limits().maxMinutes;
  if ($('ticks').dataset.max === String(max)) return;
  $('ticks').dataset.max = String(max);
  $('ticks').setAttribute('aria-valuemax', String(max));
  // Past an hour each tick is five minutes: longer marks every quarter hour, labels every half hour.
  $('ticks').innerHTML = dialSteps().map(m => {
    const major = m < 60 ? m % 15 === 0 : m % 30 === 0, minor = m < 60 ? m % 5 === 0 : m % 15 === 0;
    return `<i class="tk${major ? ' m15' : minor ? ' m5' : ''}">${major || m === 1 ? `<span>${m < 60 ? m : hm(m)}</span>` : ''}</i>`;
  }).join('');
  $('duration-presets').innerHTML = [5, 15, 30, 60, 120, 240].filter(m => m <= max).map(m => `<button data-duration="${m}" aria-pressed="false">${m < 60 ? m : `${m / 60}h`}</button>`).join('');
}
function setDial(m, smooth = true) { $('ticks').scrollTo({ left: stepIndex(m) * 10, behavior: smooth ? 'smooth' : 'instant' }); }
function renderSheet() {
  const zone = state?.zones.find(z => z.id === selected);
  if (!zone) return;
  buildDial();
  minutes = snap(minutes);
  const mode = zoneMode(zone), info = describe(zone, mode);
  const showRun = ['running', 'unknown', 'stopping'].includes(mode) || (mode === 'stale' && zone.running);
  $('sheet-number').textContent = pad(zone.id);
  $('sheet-number').classList.toggle('flagged', Boolean(zone.issues?.length));
  $('sheet-name').textContent = zone.name;
  $('sheet-status').textContent = info.text || (zone.running ? '' : 'Not running');
  $('sheet-duration').hidden = showRun || mode === 'starting';
  $('dur-block').hidden = showRun;
  $('sheet-timer').hidden = !showRun;
  $('sheet-blocked').textContent = showRun || mode === 'starting' ? '' : blockedReason();
  $('sheet-start').hidden = showRun || mode === 'starting';
  $('sheet-start').disabled = Boolean(blockedReason());
  $('sheet-start').innerHTML = `${icon('drop')}Water for ${duration(minutes)}`;
  $('sheet-stop').hidden = !(zone.running && zone.owned) || mode === 'stopping';
  $('sheet-stop').disabled = !canControl();
  const planText = plan.describeZone(zone.id);
  $('sheet-plan').hidden = !planText; $('sheet-plan-text').textContent = planText ?? '';
  $('sheet-favorite').setAttribute('aria-pressed', String(zone.favorite));
  $('sheet-favorite').querySelector('span').textContent = zone.favorite ? 'Favorite' : 'Favorite';
  $('sheet-favorite').setAttribute('aria-label', zone.favorite ? 'Remove from favorites' : 'Add to favorites');
  for (const id of ['sheet-favorite', 'edit-zone', 'sheet-flag']) $(id).disabled = controlsBusy();
  html('sheet-issues', issueRows([zone]));
  $('sheet-notes').textContent = zone.notes || '';
  $('duration-value').textContent = minutes < 60 ? minutes : hm(minutes);
  $('duration-unit').textContent = minutes < 60 ? 'min' : minutes === 60 ? 'hour' : 'hours';
  $('ticks').setAttribute('aria-valuenow', String(minutes));
  $('ticks').setAttribute('aria-valuetext', duration(minutes));
  document.querySelectorAll('[data-duration]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.duration) === minutes)));
}
function issueRows(zones) {
  return zones.flatMap(z => (z.issues || []).map((item, i) => `<div class="fi"><span class="zone-num num">${pad(z.id)}</span><div><b>${escape(item.issue)}</b><span>${escape(z.name)} · ${day(item.at)}</span></div><button class="rm" data-unflag="${z.id}:${i}" aria-label="Remove ${escape(item.issue)} from ${escape(z.name)}" ${controlsBusy() ? 'disabled' : ''}>${icon('x')}</button></div>`)).join('');
}
function renderFindings() {
  const zones = state.zones.filter(z => z.issues?.length), count = zones.reduce((n, z) => n + z.issues.length, 0);
  $('findings-summary').textContent = count ? `${count} problem${count > 1 ? 's' : ''} across ${zones.length} zone${zones.length > 1 ? 's' : ''}` : 'Nothing flagged. Tap Flag a problem during a walk.';
  html('findings-list', issueRows(zones));
  $('findings-actions').hidden = !count;
  $('findings-clear').textContent = clearArmed ? 'Tap again to clear all' : 'Clear all';
  $('findings-clear').disabled = controlsBusy();
}
function renderWalk() {
  const zones = walkZones(), zone = getWalkZone(), flagged = state.zones.filter(z => z.issues?.length);
  if (zone) walkId = zone.id;
  $('walk-position').textContent = zone ? `${zones.findIndex(z => z.id === zone.id) + 1} of ${zones.length}` : 'No zones';
  const count = flagged.reduce((n, z) => n + z.issues.length, 0);
  $('findings-count').textContent = count; $('findings-count').classList.toggle('hot', count > 0);
  html('walk-rail', zones.map(z => `<button data-walk="${z.id}" class="${z.running ? 'running' : ''}${z.issues?.length ? ' flagged' : ''}" aria-label="Zone ${z.id}, ${escape(z.name)}" aria-pressed="${z.id === walkId}"><b>${pad(z.id)}</b><span>${escape(z.name)}</span></button>`).join(''));
  $('walk-number').textContent = zone ? `ZONE ${pad(zone.id)}` : 'ZONE';
  if (zone && railShown !== zone.id && tab === 'walk') {
    railShown = zone.id;
    requestAnimationFrame(() => $('walk-rail').querySelector('[aria-pressed=true]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }));
  }
  $('walk-name').textContent = zone?.name || 'No zones';
  const running = runningZones(), op = opTarget(pendingOp());
  const active = running.some(z => z.owned) || Boolean(op);
  const currentId = running[0]?.id || zone?.id;
  const next = zones[(zones.findIndex(z => z.id === currentId) + 1) % zones.length];
  $('walk-start').hidden = active;
  $('walk-start').disabled = !zone || Boolean(blockedReason());
  $('walk-start').innerHTML = zone ? `${icon('drop')}Start zone ${pad(zone.id)} · ${walkMinutes} min` : 'Start';
  $('walk-transport').hidden = !active;
  $('next-zone').innerHTML = next ? `<span>Next: ${escape(next.name)}</span>${icon('next')}` : 'Next';
  $('next-zone').setAttribute('aria-label', next ? `Stop this zone and start ${next.name}` : 'Next');
  $('next-zone').disabled = !canControl() || !next || (state.available && (running.some(z => !z.owned) || Number(state.status.rainShutDown) > 0));
  $('walk-stop').disabled = !canControl() || !running.some(z => z.owned);
  $('walk-flag').disabled = !zone || controlsBusy();
  $('walk-details').disabled = !zone;
  document.querySelectorAll('[data-walk-minutes]').forEach(b => { b.setAttribute('aria-checked', String(Number(b.dataset.walkMinutes) === walkMinutes)); b.disabled = controlsBusy(); });
  $('tilt').hidden = !waterFX.tilt.available;
}
function render() {
  if (!state) return;
  const running = runningZones(), runs = lastRuns();
  showPending();
  const status = connectionStatus();
  $('connection-text').textContent = status[0]; $('connection').className = `status ${status[1]}`;
  $('mode-note').hidden = state.mode !== 'demo' && state.controlEnabled;
  $('mode-note').textContent = state.mode === 'demo' ? 'Simulation. Controls never reach real irrigation.' : 'Read-only. Watering is turned off on the server.';
  $('refresh').disabled = controlsBusy();
  $('voltage').textContent = state.status.voltageV == null ? '—' : `${state.status.voltageV} V`;
  $('current').textContent = state.status.current == null ? '—' : `${state.status.current} mA`;
  $('observed').textContent = state.observedAt ? ago(state.observedAt) : '—';
  renderConnection();
  const zones = visibleZones();
  $('zone-count').textContent = `${zones.length} zones`;
  $('empty').hidden = zones.length > 0; $('zones').hidden = !zones.length;
  html('zones', zones.map(z => {
    const mode = zoneMode(z), live = mode === 'running' || mode === 'unknown';
    const issue = z.issues?.at(-1), last = runs[z.id];
    const meta = mode === 'starting' ? 'Starting…' : mode === 'stopping' ? 'Stopping…' : live ? (z.owned ? 'Watering' : 'Watering · started at the controller')
      : issue ? `<span class="issue">${escape(issue.issue)}</span> · flagged ${day(issue.at)}`
      : last ? `Last run ${day(last.at)} · ${duration(last.minutes)}` : escape((z.notes || '').split('\n')[0]);
    const end = mode === 'running' ? `<span class="zone-end" data-rem="${z.id}"></span>` : `<span class="zone-end">${icon('next')}</span>`;
    return `<button class="zone${live ? ' running' : ''}${mode === 'starting' || mode === 'stopping' ? ' pending' : ''}" data-zone="${z.id}" aria-label="${escape(z.name)}, zone ${z.id}${live ? ', watering' : ''}"><span class="zone-num">${pad(z.id)}</span><span class="zone-text"><span class="zone-name"><span>${escape(z.name)}</span>${z.favorite ? icon('star', 'fav') : ''}${z.issues?.length ? icon('flag') : ''}</span><span class="zone-meta">${meta}</span></span>${end}</button>`;
  }).join(''));
  renderWeather();
  if (tab === 'plan') plan.render();
  html('activity', state.events.length ? state.events.map(e => `<div class="event"><strong>${escape(e.kind.replace('/api/','').replaceAll('/',' · '))}</strong> · <span class="${e.data.outcome === 'failed' ? 'failure' : ''}">${escape(e.data.outcome)}</span><small>${new Date(e.at).toLocaleString()}${e.data.message ? ` · ${escape(e.data.message)}` : ''}</small></div>`).join('') : '<p class="muted">Nothing yet.</p>');
  renderWalk(); renderSheet();
  if ($('findings-dialog').open) renderFindings();
  if (running.length === 0 && !pendingOp()) clearArmed = clearArmed && $('findings-dialog').open;
  tick();
}
/* ---------- weather ---------- */
// Values arrive in millimeters; show them in whatever the station reports.
const rainUnit = () => state.weatherReading?.sample?.unit || (navigator.language === 'en-US' ? 'in' : 'mm');
// Readings show a trace as "<0.01"; thresholds (limit) always round to a plain figure.
const depth = (mm, trace = true) => { const v = rainUnit() === 'in' ? mm / 25.4 : mm, places = rainUnit() === 'in' ? 2 : 1; return trace && v > 0 && v < 10 ** -places ? `<${(10 ** -places).toFixed(places)}` : v < 10 ? Math.max(v, trace ? 0 : 10 ** -places).toFixed(places) : Math.round(v).toString(); };
const limit = mm => depth(mm, false);
const because = (reason, trigger) => !trigger ? reason
  : trigger.kind === 'intensity' ? `Raining ${depth(trigger.mm)} ${rainUnit()}/h`
  : trigger.kind === 'accumulation' ? `${depth(trigger.mm)} ${rainUnit()} of rain today`
  : `Forecast of ${depth(trigger.mm)} ${rainUnit()} at ${Math.round(trigger.probability)}%`;
const hoursLeft = s => s >= 3600 ? `${Math.round(s / 3600)} h` : `${Math.max(1, Math.ceil(s / 60))} min`;
const whenAt = ms => { const days = Math.round((new Date(new Date(ms).toDateString()) - new Date(new Date().toDateString())) / 864e5); return `${days === 0 ? '' : days === 1 ? 'tomorrow ' : `${new Date(ms).toLocaleDateString([], { weekday: 'short' })} `}${at(ms)}`; };
const MODE_TEXT = {
  off: 'Weather is ignored and the station isn’t read.',
  observe: 'Watches the weather and records what it would do. It never changes the controller.',
  automatic: 'Sets a rain delay when a threshold is met. It never shortens a delay you set.',
};
function renderWeather() {
  const unit = rainUnit(), policy = state.policy, now = Date.now();
  // Rain delay, counted down from the controller's last report.
  const observed = Date.parse(state.observedAt);
  const reported = Number(state.status.rainShutDown) || 0;
  const remaining = Math.max(0, reported - (Number.isFinite(observed) ? (now - observed) / 1000 : 0));
  const on = remaining > 0, rain = state.rain, ours = on && rain && Math.abs(Date.parse(rain.until) - (now + remaining * 1000)) < 180000;
  $('delay-card').classList.toggle('on', on);
  $('delay-icon').className = `badge-icon${on ? ' water' : ''}`;
  $('delay-title').textContent = on ? `${hoursLeft(remaining)} left` : 'Off';
  const origin = !on ? '' : ours ? (rain.source === 'weather' ? `Set by the weather: ${because(rain.reason, rain.trigger)}` : 'Set from 2core') : 'Set at the controller or in Tucor';
  const asOf = !state.available && state.observedAt ? ` As of ${at(observed)}.` : '';
  $('delay-detail').textContent = on ? `Until ${whenAt(now + remaining * 1000)}. ${origin}.${asOf}` : `The controller’s schedule runs as normal.${asOf}`;
  $('delay-meter').hidden = !(ours && rain.hours);
  if (ours && rain.hours) $('delay-fill').style.width = `${Math.min(100, remaining / (rain.hours * 36))}%`;
  document.querySelectorAll('[data-rain]').forEach(b => b.disabled = !canControl() || (b.dataset.rain === '0' && !on));

  // Weather source health.
  const source = state.weatherSource, reading = state.weatherReading, off = policy.mode === 'off';
  const age = reading?.at ? now - Date.parse(reading.at) : Infinity;
  const failing = reading?.error && (!reading.at || Date.parse(reading.errorAt) >= Date.parse(reading.at));
  let pill, note;
  if (!source?.configured) {
    pill = source?.error ? ['Setup problem', 'bad'] : ['Not set up', ''];
    note = source?.error ? `${source.error}.` : 'On the server, run tools/configure-secrets.py --weatherflow to connect your Tempest.';
  } else if (off) {
    pill = ['Paused', '']; note = 'Not reading while automatic rain delay is off.';
  } else if (failing) {
    pill = [/fresh/.test(reading.error) ? 'No readings' : 'Can’t connect', 'bad'];
    note = `${reading.error}${reading.at ? `. Last good reading ${ago(reading.at)}` : ''}. Missing readings never count as dry.`;
  } else if (reading?.at) {
    pill = age < 11 * 60000 ? [`Live · ${ago(reading.at)}`, 'ok'] : [`Last read ${ago(reading.at)}`, 'warn'];
    note = `${source.source === 'Simulator' ? 'Sample data' : `Station ${source.station?.id} via WeatherFlow`}. Checked every 5 minutes.`;
  } else {
    pill = ['Connecting', 'warn']; note = 'Waiting for the first reading.';
  }
  $('station-title').textContent = source?.source === 'Simulator' ? 'Simulated station' : source?.station?.name || 'Tempest';
  $('station-pill').className = `pill ${pill[1]}`; $('station-status').textContent = pill[0];
  $('station-note').textContent = note;
  const sample = source?.configured && reading?.sample, configured = Boolean(source?.configured);
  const tile = (label, configured, value, threshold, unitLabel, sub, wet = value >= threshold) => {
    const has = configured && value != null;
    return `<div class="reading${!has ? ' none' : wet ? ' wet' : ''}"><span class="label">${label}</span><strong>${has ? depth(value) : '—'}<small>${unitLabel}</small></strong><div class="meter"><i data-fill="${has ? Math.min(100, value / threshold * 100) : 0}"></i></div><span class="sub">${!configured ? 'Not selected' : !has ? 'No reading' : wet ? 'Over threshold' : sub}</span></div>`;
  };
  const chance = sample?.forecastProbability;
  html('readings', [
    tile('Rain now', configured, sample?.intensityMmH, policy.intensityMmH, `${unit}/h`, `Delays at ${limit(policy.intensityMmH)}`),
    tile('Today', configured, sample?.accumulationMm, policy.accumulationMm, unit, `Delays at ${limit(policy.accumulationMm)}`),
    // A forecast counts only when both its amount and its probability clear their thresholds.
    tile('Next 12 h', configured, sample?.forecastMm, policy.forecastMm, chance == null ? unit : `${unit} · ${Math.round(chance)}%`,
      `Delays at ${limit(policy.forecastMm)}, ${policy.forecastProbability}%+`, sample?.forecastMm >= policy.forecastMm && chance >= policy.forecastProbability),
  ].join(''));
  // The page's CSP forbids inline style attributes; set meter widths through the DOM.
  $('readings').querySelectorAll('[data-fill]').forEach(el => { el.style.width = `${el.dataset.fill}%`; });

  // Automation mode and its latest decision.
  document.querySelectorAll('[data-mode]').forEach(b => { b.setAttribute('aria-checked', String(b.dataset.mode === policy.mode)); b.disabled = controlsBusy(); });
  $('mode-explain').textContent = MODE_TEXT[policy.mode] + (policy.mode === 'automatic' && !state.controlEnabled ? ' Live control is off on the server, so nothing will be set.' : '');
  const d = state.weatherDecision;
  let icon, title, detail;
  if (off) [icon, title, detail] = ['clock', 'Not watching', 'Choose Log only to see what 2core would do.'];
  else if (!d) [icon, title, detail] = ['clock', 'No decision yet', source?.configured ? 'The first one comes with the next reading.' : 'Set up a weather source first.'];
  else {
    const when = `Checked ${ago(d.at)}`, why = because(d.reason, d.trigger);
    if (/^Rain delay not set/.test(d.reason)) [icon, title, detail] = ['danger', 'Couldn’t set a delay', `${d.reason.replace(/^Rain delay not set: /, '')}. ${when}.`];
    else if (!d.wet) [icon, title, detail] = ['leaf', 'Dry, nothing to do', /stale|missing/i.test(d.reason) ? `${d.reason}. ${when}.` : `No threshold met. ${when}.`];
    else if (d.applied) [icon, title, detail] = ['water', `Set a ${policy.holdHours} h delay`, `${why}. ${when}.`];
    else if (d.preserved) [icon, title, detail] = ['soft-water', 'Delay already in place', `${d.preserved}. ${when}.`];
    else if (d.blocked) [icon, title, detail] = ['amber', `Would set a ${policy.holdHours} h delay`, `${why}. Live control is off. ${when}.`];
    else [icon, title, detail] = ['amber', `Would set a ${policy.holdHours} h delay`, `${why}. Log only, so nothing changed. ${when}.`];
  }
  $('decision-icon').className = `badge-icon small ${icon === 'clock' ? '' : icon}`;
  $('decision-icon').innerHTML = `<svg><use href="#i-${icon === 'leaf' ? 'check' : icon === 'danger' || icon === 'amber' ? 'alert' : icon === 'clock' ? 'clock' : 'rain'}"/></svg>`;
  $('decision-title').textContent = title; $('decision-detail').textContent = detail;
  $('policy-rule').textContent = `Delays ${policy.holdHours} h when rain reaches ${limit(policy.intensityMmH)} ${unit}/h, today’s total reaches ${limit(policy.accumulationMm)} ${unit}, or the next 12 hours forecast ${limit(policy.forecastMm)} ${unit} at ${policy.forecastProbability}% or more. Missing readings never count as dry.`;
}
function connectionStatus() {
  const c = state.connection || {};
  if (!reachable) return ['Offline', 'bad'];
  if (state.mode === 'demo') return ['Simulation', ''];
  if (c.checking) return ['Checking controller', 'stale'];
  if (state.available) return [`${c.open ? 'Connected' : 'Checked'} · ${ago(state.observedAt)}`, ''];
  if (c.retryAt) return ['Retrying later · tap for details', 'bad'];
  if (state.error) return ['Controller unreachable', 'bad'];
  return [state.observedAt ? `Paused · checked ${ago(state.observedAt)}` : 'Paused · tap to check', 'stale'];
}
function renderConnection() {
  const c = state.connection;
  $('tucor-group').hidden = !c?.limits;
  $('tucor-sessions').textContent = c?.limits ? `${c.sessionsLastHour} of ${c.limits.sessionsPerHour}` : '—';
  $('tucor-logins').textContent = c?.limits ? `${c.loginsToday} of ${c.limits.loginsPerDay}` : '—';
  const note = c?.retryAt ? `After a failed connection, 2core waits until ${at(Date.parse(c.retryAt))} before connecting on its own. Your commands can still retry.` : c?.lastError ? `Last problem: ${c.lastError}` : '2core only connects while you use the app or when a rain delay needs setting.';
  $('tucor-note').textContent = note;
  html('tucor-history', (c?.history || []).map(h => `<div class="event"><span class="${h.ok ? '' : 'failure'}">${h.ok ? 'Connected' : escape(h.error)}</span><small>${new Date(h.at).toLocaleString()}${h.codes?.length ? ` · ${escape(h.codes.join(' '))}` : ''}</small></div>`).join(''));
}
function tick() {
  if (!state) return;
  const now = Date.now();
  document.querySelectorAll('[data-rem]').forEach(el => { const z = state.zones.find(z => z.id === el.dataset.rem); if (z?.endsAt) el.textContent = clock(Date.parse(z.endsAt) - now); });
  if (reachable) $('connection-text').textContent = connectionStatus()[0];

  // Walk vessel
  const zone = getWalkZone(), mode = zoneMode(zone), info = describe(zone, mode);
  // The countdown is the big number; the name is the heading above the vessel.
  const big = mode === 'running' ? info.short : mode === 'idle' ? clock(walkMinutes * 60000) : info.short;
  const word = mode === 'running' ? 'left' : mode === 'idle' ? 'Ready' : mode === 'unknown' ? '' : '';
  $('walk-time').textContent = big; $('walk-word').textContent = word;
  $('walk-state').textContent = info.text; $('walk-state').className = `walk-state ${info.cls}`;
  $('walk-detail').textContent = ['idle', 'failed'].includes(mode) && blockedReason() && !zone?.running ? blockedReason() : zone?.issues?.length ? `Flagged: ${zone.issues.map(i => i.issue).join(', ')}` : (zone?.notes || '').split('\n')[0];
  const level = zone ? levelOf(zone, mode) : 0;
  $('water-orb').classList.toggle('watering', ['running', 'unknown'].includes(mode) && tab === 'walk');
  $('water-orb').querySelector('.water-level').style.transform = `translate3d(0,${(1 - level) * 100}%,0)`;

  // Sheet tank
  const sheetZone = state.zones.find(z => z.id === selected), sheetMode = zoneMode(sheetZone);
  const sheetOpen = $('zone-dialog').open;
  let tankState = null;
  if (sheetOpen && sheetZone) {
    const showRun = ['running', 'unknown', 'stopping'].includes(sheetMode) || (sheetMode === 'stale' && sheetZone.running);
    if (showRun) {
      $('sheet-timer').textContent = sheetZone.endsAt && sheetZone.owned ? clock(Date.parse(sheetZone.endsAt) - now) : 'Watering';
      $('tank-caption').innerHTML = sheetZone.endsAt && sheetZone.owned ? `left · ends at <b>${at(Date.parse(sheetZone.endsAt))}</b>` : 'End time unknown';
      tankState = { mode: sheetMode, level: levelOf(sheetZone, sheetMode), tone: 'water', frost: sheetMode === 'stale' };
    } else if (sheetMode === 'starting') {
      $('tank-caption').textContent = waitText(pendingOp());
      tankState = { mode: 'starting', level: 0, tone: 'water', frost: false };
    } else {
      $('tank-caption').innerHTML = `Ends at <b>${at(now + minutes * 60000)}</b> if started now`;
      tankState = { mode: 'idle', level: 0.06 + 0.86 * stepIndex(minutes) / (dialSteps().length - 1), tone: sheetMode === 'failed' ? 'amber' : 'water', frost: !reachable || !state.available };
    }
    $('sheet-status').textContent = describe(sheetZone, sheetMode).text || 'Not running';
  }

  // Run capsule in the dock: the running zone, or the one we're waiting on.
  const op = opTarget(pendingOp());
  const capZone = runningZones()[0] || (op?.action === 'start' ? state.zones.find(z => z.id === op.zone) : null);
  const capMode = zoneMode(capZone);
  // On Walk the vessel already shows the run, so the capsule would only cover the controls.
  $('run-dock').hidden = !capZone || tab === 'walk';
  if (capZone) {
    const capInfo = describe(capZone, capMode);
    $('dock-name').textContent = capZone.name;
    $('dock-time').textContent = capMode === 'running' ? `${clock(Date.parse(capZone.endsAt) - now)} left` : capInfo.text || capInfo.short;
    $('run-dock').classList.toggle('wait', capMode === 'starting' || capMode === 'stopping');
    $('stop').hidden = !(capZone.running && capZone.owned) || capMode === 'stopping';
    $('stop').disabled = !canControl();
  }

  waterFX.update({
    enabled: !$('application').hidden, tab,
    modal: [...document.querySelectorAll('dialog')].some(d => d.open),
    sheet: sheetOpen && Boolean(tankState), running: reachable && state.available && runningZones().length > 0,
    vessel: zone ? { mode: ['failed', 'offline'].includes(mode) ? (mode === 'offline' ? 'stale' : 'idle') : mode, level, label: `ZONE ${pad(zone.id)}`, big, word, tone: info.tone, frost: mode === 'stale' || mode === 'offline' } : null,
    tankState,
    capsule: capZone ? { mode: capMode === 'offline' ? 'stale' : capMode, level: levelOf(capZone, capMode) } : null,
  });
}
async function startZone(id, duration) {
  if (blockedReason()) return;
  walkId = id;
  await act(`/zones/${id}/start`, { minutes:duration });
}
async function saveIssues(zone, issues) {
  return act(`/zones/${zone.id}/preferences`, { issues }, 'Saving…');
}
async function waitUntilIdle(limit = 15000) {
  const until = Date.now() + limit;
  while (controlsBusy() && Date.now() < until) { await new Promise(r => setTimeout(r, 400)); await load(); }
  return !controlsBusy();
}

const plan = createPlan({ $, api, escape, message, html, getState: () => state, zoneEnabled: waterFX.zoneEnabled });

/* ---------- events ---------- */
$('login-form').addEventListener('submit', async e => { e.preventDefault(); key = $('access-key').value.trim(); sessionStorage.setItem('2core-key',key); prepare(true); await load(); });
$('signout').addEventListener('click', () => { sessionStorage.removeItem('2core-key'); location.reload(); });
$('refresh').addEventListener('click', () => act('/refresh'));
// The status pill checks now when paused, and explains when 2core is holding back.
$('connection').addEventListener('click', () => state?.connection?.retryAt || state?.error ? showTab('activity') : act('/refresh'));
$('stop').addEventListener('click', () => act('/stop'));
$('walk-stop').addEventListener('click', () => act('/stop'));
$('search').addEventListener('input', render);
for (const id of ['favorites', 'flagged', 'show-unused']) $(id).addEventListener('click', () => { $(id).setAttribute('aria-pressed', String(!isPressed(id))); render(); });
document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('zones').addEventListener('click', e => { const b = e.target.closest('[data-zone]'); if (b) openZone(b.dataset.zone); });
$('walk-rail').addEventListener('click', e => { const b = e.target.closest('[data-walk]'); if (b) { walkId = b.dataset.walk; renderWalk(); tick(); } });
document.querySelectorAll('[data-walk-minutes]').forEach(b => b.addEventListener('click', () => { walkMinutes = Number(b.dataset.walkMinutes); store('2core-walk-minutes', walkMinutes); renderWalk(); }));
$('walk-start').addEventListener('click', () => startZone(getWalkZone().id, walkMinutes));
$('walk-details').addEventListener('click', () => openZone(getWalkZone().id));
$('next-zone').addEventListener('click', async () => {
  if (controlsBusy() || $('next-zone').disabled) return;
  const zones = walkZones(), running = runningZones();
  const currentId = running[0]?.id || getWalkZone()?.id;
  const next = zones[(zones.findIndex(z => z.id === currentId) + 1) % zones.length];
  if (!running.length) { walkId = next.id; render(); $('walk-rail').querySelector('[aria-pressed=true]')?.scrollIntoView({ block:'nearest',inline:'center' }); return; }
  walkId = next.id;
  // One accepted operation owns both steps, even while the phone is locked.
  await act(`/zones/${next.id}/next`, { minutes: walkMinutes });
});
$('tilt').addEventListener('click', async () => {
  motionEnabled = await waterFX.tilt.toggle();
  store('2core-motion-enabled', motionEnabled);
  $('tilt').setAttribute('aria-pressed', String(motionEnabled));
});
for (const id of ['active-open', 'dock-open']) $(id)?.addEventListener('click', () => { const z = runningZones()[0] || state.zones.find(z => z.id === opTarget(pendingOp())?.zone); if (z) openZone(z.id); });
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('close', tick);
  // Tapping the dimmed backdrop closes a sheet.
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
}
$('close-zone').addEventListener('click', () => $('zone-dialog').close());
$('close-flag').addEventListener('click', () => $('flag-dialog').close());
$('close-findings').addEventListener('click', () => $('findings-dialog').close());

// Minute dial: scroll to choose; the tank fills with the water the run will use.
$('ticks').addEventListener('scroll', () => {
  const steps = dialSteps(), index = Math.max(0, Math.min(steps.length - 1, Math.round($('ticks').scrollLeft / 10)));
  const m = steps[index];
  if (m === minutes) return;
  waterFX.pour(index - stepIndex(minutes));
  minutes = m; store('2core-minutes', m); renderSheet(); tick();
}, { passive: true });
$('ticks').addEventListener('keydown', e => {
  const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
  if (step) { const steps = dialSteps(); e.preventDefault(); setDial(steps[Math.max(0, Math.min(steps.length - 1, stepIndex(minutes) + step))]); }
});
$('duration-presets').addEventListener('click', e => { const b = e.target.closest('[data-duration]'); if (b) setDial(Number(b.dataset.duration)); });
$('sheet-start').addEventListener('click', () => startZone(selected, minutes));
$('sheet-stop').addEventListener('click', () => act(`/zones/${selected}/stop`));
$('sheet-favorite').addEventListener('click', () => { const z = state.zones.find(z => z.id === selected); act(`/zones/${selected}/preferences`,{ favorite:!z.favorite },'Saving favorite…'); });

// Flagging: her eyes are the leak detector, so recording a problem is one tap.
function openFlag(id) {
  flagZone = state.zones.find(z => z.id === id);
  if (!flagZone) return;
  $('flag-number').textContent = pad(flagZone.id);
  $('flag-zone').textContent = flagZone.name;
  $('flag-options').innerHTML = ISSUES.map(i => `<button data-issue="${escape(i)}">${icon('flag')}${escape(i)}</button>`).join('');
  $('flag-dialog').showModal();
}
$('walk-flag').addEventListener('click', () => openFlag(getWalkZone()?.id));
$('sheet-plan').addEventListener('click', () => { const id = selected; $('zone-dialog').close(); plan.openZone(id); });
$('sheet-flag').addEventListener('click', () => { const id = selected; $('zone-dialog').close(); openFlag(id); });
$('flag-options').addEventListener('click', e => {
  const b = e.target.closest('[data-issue]'); if (!b || !flagZone) return;
  const issues = [...(flagZone.issues || []), { issue: b.dataset.issue, at: new Date().toISOString() }].slice(-limits().issues || -20);
  $('flag-dialog').close();
  saveIssues(flagZone, issues);
});
$('findings-open').addEventListener('click', () => { clearArmed = false; renderFindings(); $('findings-dialog').showModal(); });
document.addEventListener('click', e => {
  const b = e.target.closest('[data-unflag]'); if (!b) return;
  const [id, index] = b.dataset.unflag.split(':');
  const zone = state.zones.find(z => z.id === id);
  if (zone) saveIssues(zone, zone.issues.filter((_, i) => i !== Number(index)));
});
$('findings-copy').addEventListener('click', () => {
  const text = ['Irrigation findings', ...state.zones.flatMap(z => (z.issues || []).map(i => `Zone ${z.id} (${z.name}): ${i.issue}, ${day(i.at)}`))].join('\n');
  navigator.clipboard?.writeText(text).then(() => message('Copied the findings list.'), () => message('Couldn’t copy. Select the list and copy it instead.', true));
});
$('findings-clear').addEventListener('click', async () => {
  if (!clearArmed) { clearArmed = true; renderFindings(); return; }
  clearArmed = false;
  for (const zone of state.zones.filter(z => z.issues?.length)) {
    if (!await waitUntilIdle()) break;
    await saveIssues(zone, []);
  }
  await waitUntilIdle(); renderFindings();
});

$('edit-zone').addEventListener('click', () => {
  editing = state.zones.find(z => z.id === selected);
  $('notes-title').textContent = `Zone ${editing.id}`; $('zone-name').value = editing.name; $('zone-order').value = editing.order; $('zone-notes').value = editing.notes;
  $('zone-dialog').close(); $('notes-dialog').showModal();
});
$('cancel-notes').addEventListener('click', () => { $('notes-dialog').close(); openZone(editing.id); });
$('notes-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (controlsBusy()) return;
  const body = { name:$('zone-name').value, notes:$('zone-notes').value, order:Number($('zone-order').value) };
  $('notes-dialog').close(); openZone(editing.id);
  await act(`/zones/${editing.id}/preferences`,body,'Saving zone details…');
});
document.querySelectorAll('[data-rain]').forEach(b => b.addEventListener('click', () => act('/rain',{ hours:Number(b.dataset.rain) })));
$('policy-modes').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b && b.getAttribute('aria-checked') !== 'true') act('/policy', { mode:b.dataset.mode }, 'Saving weather mode…'); });
document.addEventListener('visibilitychange', () => { document.body.classList.toggle('page-hidden',document.hidden); if (!document.hidden) { lastInteraction = Date.now(); prepare(); load(); } });
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, interacted, { capture:true, passive:true });
setInterval(() => { if (!document.hidden && Date.now() - lastInteraction < ACTIVE_MS) prepare(); }, HEARTBEAT_MS);
if (motionEnabled) waterFX.tilt.set(true).then(enabled => $('tilt').setAttribute('aria-pressed', String(enabled)));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
setInterval(() => { if (!document.hidden && !$('notes-dialog').open) load(); },1500);
setInterval(() => { if (!document.hidden) tick(); },1000);
prepare(true);
load();
fetch('/healthz').then(r => r.json()).then(info => { $('demo-hint').hidden = info.mode !== 'demo'; }).catch(() => {});
