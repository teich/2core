import { createWaterFX } from './water.js';
const $ = id => document.getElementById(id);
const implicitAuth = await import('./auth.js').then(m => m.detectImplicitAuthentication()).catch(() => false);
let key = sessionStorage.getItem('2core-key') || '';
let state, busy = false, loading = false, pendingLoad, editing, selected, walkId, tab = 'zones', minutes = 5;
const runDurations = new Map();
const waterFX = createWaterFX();
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const uuid = () => globalThis.crypto?.randomUUID ? crypto.randomUUID() : `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const runningZones = () => state?.zones.filter(z => z.running) || [];
const canControl = () => state?.available && state.controlEnabled && !busy;
const isPressed = id => $(id).getAttribute('aria-pressed') === 'true';
const visibleZones = () => state.zones.filter(z => (z.configured || isPressed('show-unused')) && (!isPressed('favorites') || z.favorite) && `${z.name} ${z.id} ${z.notes}`.toLowerCase().includes($('search').value.trim().toLowerCase()));
const walkZones = () => state.zones.filter(z => z.configured || isPressed('show-unused'));
const getWalkZone = () => walkZones().find(z => z.id === walkId) || walkZones().find(z => z.running) || walkZones()[0];
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
  $('message').hidden = !text; $('message').textContent = text; $('message').className = error ? 'error' : '';
  $('sheet-feedback').textContent = text; $('sheet-feedback').className = error ? 'failure' : '';
}
async function api(path, body) {
  const response = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': uuid() } : {}) },
    body: body ? JSON.stringify({ ...body, deadline: new Date(Date.now() + 60000).toISOString() }) : undefined,
    signal: AbortSignal.timeout(90000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function load() {
  if (!key && !implicitAuth) return false;
  // A command refresh waits for any older poll, then reads fresh state.
  if (loading) await pendingLoad;
  loading = true;
  let resolveLoad;
  pendingLoad = new Promise(resolve => { resolveLoad = resolve; });
  try {
    state = await api('/state');
    $('login').hidden = true; $('application').hidden = false; $('signout').hidden = implicitAuth; $('login-error').textContent = '';
    render(); return true;
  } catch (e) {
    $('connection').textContent = 'Offline'; $('connection').className = 'badge bad';
    if (!state) $('login-error').textContent = e.message;
    else { state.available = false; render(); message(`${e.message}. Commands will not be queued or retried.`, true); }
    return false;
  } finally { loading = false; resolveLoad(); }
}
async function act(path, body = {}, label = 'Waiting for controller confirmation…') {
  if (busy) return false;
  busy = true; message(label); render();
  try { await api(path, body); if (!await load()) return false; message('Confirmed.'); return true; }
  catch (e) { message(e.message, true); await load(); return false; }
  finally { busy = false; render(); }
}
function blockedReason() {
  if (!state.available) return 'Controller unavailable. Refresh before watering.';
  if (!state.controlEnabled) return 'Read-only mode. Live watering is disabled on the server.';
  if (busy) return 'Waiting for controller confirmation…';
  if (Number(state.status.rainShutDown) > 0) return 'Rain hold active. Clear it in Weather before testing a zone.';
  if (runningZones().length) return 'A zone is already running. Stop it before starting another.';
  return '';
}
function showTab(name) {
  tab = name; document.body.dataset.view = name;
  const titles = { zones:'Garden zones', walk:'Walk the garden', rain:'Rain & weather', activity:'Garden activity' };
  $('view-title').textContent = titles[name];
  document.querySelectorAll('[data-tab]').forEach(b => b.dataset.tab === name ? b.setAttribute('aria-current','page') : b.removeAttribute('aria-current'));
  for (const view of Object.keys(titles)) $(`${view}-view`).hidden = view !== name;
  window.scrollTo({ top:0, behavior:'instant' });
  render();
}
function openZone(id) {
  selected = id; $('sheet-feedback').textContent = ''; renderSheet();
  $('zone-dialog').showModal(); tick();
}
function renderSheet() {
  const zone = state?.zones.find(z => z.id === selected);
  if (!zone) return;
  $('sheet-number').textContent = `ZONE ${zone.id.padStart(2,'0')}`;
  $('sheet-name').textContent = zone.name;
  $('sheet-status').textContent = !state.available ? 'Status unavailable' : zone.running ? zone.owned ? 'Watering now · Timer on the controller' : 'External run · Manage it on the controller' : 'Ready for a little attention';
  $('sheet-duration').hidden = Boolean(zone.running);
  $('sheet-timer').hidden = !zone.running;
  $('sheet-blocked').textContent = blockedReason();
  $('sheet-start').hidden = Boolean(zone.running);
  $('sheet-start').disabled = Boolean(blockedReason());
  $('sheet-start').textContent = `Start watering · ${minutes === 60 ? '1 hour' : `${minutes} min`}`;
  $('sheet-stop').hidden = !zone.running || !zone.owned;
  $('sheet-stop').disabled = !canControl();
  $('sheet-favorite').textContent = zone.favorite ? '★ Favorited' : '☆ Favorite';
  $('sheet-favorite').setAttribute('aria-pressed', String(zone.favorite));
  $('sheet-favorite').disabled = busy;
  $('edit-zone').disabled = busy;
  $('sheet-notes').textContent = zone.notes || 'No inspection notes yet.';
  $('duration-value').textContent = minutes;
  document.querySelectorAll('[data-duration]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.duration) === minutes)));
  tick();
}
function renderWalk() {
  const zones = walkZones(), zone = getWalkZone();
  if (zone) walkId = zone.id;
  $('walk-position').textContent = zone ? `${zones.findIndex(z => z.id === zone.id) + 1} of ${zones.length} zones` : 'No zones available';
  html('walk-rail', zones.map(z => `<button data-walk="${z.id}" class="${z.running ? 'running' : ''}" aria-label="Select zone ${escape(z.name)}" aria-pressed="${z.id === walkId}">${escape(z.id.padStart(2,'0'))}</button>`).join(''));
  $('walk-number').textContent = zone?.id.padStart(2,'0') || '—';
  $('walk-name').textContent = zone?.name || 'No zones available';
  $('walk-detail').textContent = zone?.notes || 'Check the line. Take your time.';
  $('walk-start').disabled = !zone || Boolean(blockedReason());
  $('walk-start').textContent = zone?.running ? 'Watering now' : 'Start this zone';
  const running = runningZones();
  $('next-zone').disabled = !canControl() || !zones.length || running.some(z => !z.owned) || Number(state.status.rainShutDown) > 0;
  $('next-zone').textContent = running.length ? 'Stop & run next →' : 'Next zone →';
  $('walk-details').disabled = !zone;
  $('walk-minutes').disabled = busy;
  if (blockedReason() && !zone?.running) $('walk-detail').textContent = blockedReason();
}
function render() {
  if (!state) return;
  const running = runningZones();
  $('connection').textContent = !state.available ? 'Unavailable' : state.mode === 'demo' ? 'Simulation' : 'Connected';
  $('connection').className = `badge ${state.available ? '' : 'bad'}`;
  $('controller').textContent = state.controller?.name ?? 'YOUR GARDEN';
  $('mode-note').textContent = state.mode === 'demo' ? 'SIMULATION · Sample garden. Controls never affect real irrigation.' : state.controlEnabled ? 'LIVE · Timed watering and rain delays affect your irrigation.' : 'READ-ONLY · Live watering is disabled until supervised validation.';
  $('refresh').disabled = busy;
  $('active-card').hidden = !running.length;
  $('active-name').textContent = running.map(z => z.name).join(', ');
  $('active-detail').textContent = running.some(z => !z.owned) ? 'Started outside 2core. Manage on the controller.' : 'The controller keeps the timer. You can put your phone away.';
  $('run-dock').hidden = !running.length;
  $('dock-name').textContent = running.map(z => z.name).join(', ');
  $('stop').hidden = !running.some(z => z.owned); $('stop').disabled = !canControl();
  $('voltage').textContent = state.status.voltageV == null ? '—' : `${state.status.voltageV} V`;
  $('current').textContent = state.status.current == null ? '—' : `${state.status.current} mA`;
  $('flow').textContent = state.status.currentFlow == null ? '—' : `${state.status.currentFlow} gal/min`;
  $('observed').textContent = state.observedAt ? new Date(state.observedAt).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) : '—';
  const zones = visibleZones();
  $('zone-count').textContent = `${zones.length} zones`;
  $('empty').hidden = zones.length > 0; $('zones').hidden = !zones.length;
  html('zones', zones.map(z => `<button class="zone ${z.running ? 'running' : ''}" data-zone="${z.id}" aria-label="${escape(z.name)}${z.running ? ', watering now' : ''}, zone ${z.id}"><span class="zone-num">${escape(z.id.padStart(2,'0'))}</span><span class="zone-text"><span class="zone-name">${escape(z.name)}${z.favorite ? ' <span aria-label="Favorite">★</span>' : ''}</span><span class="zone-meta">${!state.available ? 'Status unavailable' : z.running ? '● Watering now' : escape(z.notes || 'Ready to water')}</span></span><span class="chevron" aria-hidden="true">›</span></button>`).join(''));
  const seconds = Number(state.status.rainShutDown) || 0;
  $('rain-summary').textContent = seconds > 0 ? `Rain hold active · about ${Math.ceil(seconds/3600)} hours remaining.${state.rain?.reason ? ` ${state.rain.reason}.` : ''}` : 'No rain delay. Your normal schedule is in charge.';
  document.querySelectorAll('[data-rain]').forEach(b => b.disabled = !canControl());
  if (document.activeElement !== $('policy-mode')) $('policy-mode').value = state.policy.mode;
  $('policy-mode').disabled = busy;
  html('policy-details', `<dt>Rain intensity</dt><dd>${state.policy.intensityMmH} mm/h</dd><dt>Recent accumulation</dt><dd>${state.policy.accumulationMm} mm</dd><dt>Forecast threshold</dt><dd>${state.policy.forecastMm} mm · ${state.policy.forecastProbability}%</dd><dt>Hold duration</dt><dd>${state.policy.holdHours} hours</dd>`);
  const d = state.weatherDecision;
  $('weather-reason').textContent = d ? `${d.applied ? 'Delay applied' : d.wet ? 'Would delay' : 'Observing'}: ${d.reason}${d.blocked ? `. ${d.blocked}` : ''}${d.preserved ? `. ${d.preserved}` : ''}` : 'Waiting for Home Assistant weather observations.';
  html('activity', state.events.length ? state.events.map(e => `<div class="event"><strong>${escape(e.kind.replace('/api/','').replaceAll('/',' · '))}</strong> · <span class="${e.data.outcome === 'failed' ? 'failure' : ''}">${escape(e.data.outcome)}</span><small>${new Date(e.at).toLocaleString()}${e.data.message ? ` · ${escape(e.data.message)}` : ''}</small></div>`).join('') : '<p class="muted">Your garden activity will appear here.</p>');
  renderWalk(); renderSheet(); tick();
}
function countdown(zone) {
  if (!state.available) return 'Status unavailable';
  if (!zone?.running) return 'Ready when you are';
  if (!zone.endsAt) return 'Timer on controller';
  const sec = Math.max(0, Math.ceil((Date.parse(zone.endsAt) - Date.now()) / 1000));
  return sec === 0 ? 'Checking completion…' : `${Math.floor(sec/60).toString().padStart(2,'0')}:${(sec%60).toString().padStart(2,'0')}`;
}
function tick() {
  if (!state) return;
  const running = runningZones(), zone = getWalkZone();
  $('countdown').textContent = countdown(running[0]);
  $('dock-time').textContent = countdown(running[0]);
  $('walk-time').textContent = countdown(zone);
  $('sheet-timer').textContent = countdown(state.zones.find(z => z.id === selected));
  const remaining = zone?.endsAt ? Math.max(0, Date.parse(zone.endsAt) - Date.now()) : null;
  const duration = zone?.endsAt ? runDurations.get(`${zone.id}:${zone.endsAt}`) : null;
  // Unknown/external timer: a neutral half-full vessel, never invented progress.
  const level = state.available && zone?.running ? duration && remaining !== null ? Math.min(1,remaining / duration) : .5 : 0;
  $('water-orb').classList.toggle('watering', Boolean(state.available && zone?.running && tab === 'walk'));
  $('water-orb').querySelector('.water-level').style.transform = `translate3d(0,${(1-level)*100}%,0)`;
  waterFX.update({ enabled:!$('application').hidden, walk:tab === 'walk', modal:$('zone-dialog').open || $('notes-dialog').open, time:countdown(zone), sheet:$('zone-dialog').open && !$('sheet-duration').hidden, level:zone?.running ? level : .16, running:state.available && Boolean(zone?.running), number:zone?.id.padStart(2,'0') || '—', minutes, flow:state.available && running.length ? Math.min(.85, Math.max(0,Number(state.status.currentFlow) || 0)/16) : 0 });
}
async function startZone(id, duration) {
  if (blockedReason()) return;
  if (await act(`/zones/${id}/start`, { minutes:duration })) {
    const zone = state.zones.find(z => z.id === id);
    if (zone?.endsAt) runDurations.set(`${id}:${zone.endsAt}`, duration * 60000);
    walkId = id; render();
  }
}
$('login-form').addEventListener('submit', async e => { e.preventDefault(); key = $('access-key').value.trim(); sessionStorage.setItem('2core-key',key); await load(); });
$('signout').addEventListener('click', () => { sessionStorage.removeItem('2core-key'); location.reload(); });
$('refresh').addEventListener('click', () => act('/refresh'));
$('stop').addEventListener('click', () => act('/stop'));
$('search').addEventListener('input',render);
for (const id of ['favorites','show-unused']) $(id).addEventListener('click', () => { $(id).setAttribute('aria-pressed',String(!isPressed(id))); render(); });
document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('zones').addEventListener('click', e => { const b = e.target.closest('[data-zone]'); if (b) openZone(b.dataset.zone); });
$('walk-rail').addEventListener('click', e => { const b = e.target.closest('[data-walk]'); if (b) { walkId = b.dataset.walk; renderWalk(); tick(); } });
$('walk-start').addEventListener('click', () => startZone(getWalkZone().id,Number($('walk-minutes').value)));
$('walk-details').addEventListener('click', () => openZone(getWalkZone().id));
$('next-zone').addEventListener('click', async () => {
  if (busy || $('next-zone').disabled) return;
  const zones = walkZones(), running = runningZones();
  const currentId = running[0]?.id || getWalkZone()?.id;
  const next = zones[(zones.findIndex(z => z.id === currentId) + 1) % zones.length];
  if (!running.length) { walkId = next.id; render(); $('walk-rail').querySelector('[aria-pressed=true]')?.scrollIntoView({ block:'nearest',inline:'center' }); return; }
  // Hold the UI lock across both commands. Never start if stop or state refresh failed.
  busy = true; message('Stopping the current zone…'); render();
  try {
    await api('/stop', {});
    if (!await load()) return;
    if (runningZones().length || !state.available || !state.controlEnabled || Number(state.status.rainShutDown) > 0) throw new Error('The controller is not ready for the next zone. Refresh and check its status.');
    message('Starting the next zone…');
    const duration = Number($('walk-minutes').value);
    await api(`/zones/${next.id}/start`, { minutes:duration });
    walkId = next.id;
    if (!await load()) return;
    const zone = state.zones.find(z => z.id === next.id);
    if (zone?.endsAt) runDurations.set(`${zone.id}:${zone.endsAt}`,duration*60000);
    message('Confirmed.');
  } catch (e) { message(e.message,true); await load(); }
  finally { busy = false; render(); }
});
for (const id of ['active-open','dock-open']) $(id).addEventListener('click', () => { const z = runningZones()[0]; if (z) openZone(z.id); });
$('zone-dialog').addEventListener('close',tick);
$('close-zone').addEventListener('click', () => $('zone-dialog').close());
document.querySelectorAll('[data-duration]').forEach(b => b.addEventListener('click', () => { minutes = Number(b.dataset.duration); waterFX.slosh(); renderSheet(); }));
$('sheet-start').addEventListener('click', () => startZone(selected,minutes));
$('sheet-stop').addEventListener('click', () => act(`/zones/${selected}/stop`));
$('sheet-favorite').addEventListener('click', () => { const z = state.zones.find(z => z.id === selected); act(`/zones/${selected}/preferences`,{ favorite:!z.favorite },'Saving favorite…'); });
$('edit-zone').addEventListener('click', () => {
  editing = state.zones.find(z => z.id === selected);
  $('notes-title').textContent = `Zone ${editing.id} details`; $('zone-name').value = editing.name; $('zone-order').value = editing.order; $('zone-notes').value = editing.notes;
  $('zone-dialog').close(); $('notes-dialog').showModal();
});
$('cancel-notes').addEventListener('click', () => { $('notes-dialog').close(); openZone(editing.id); });
$('notes-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (busy) return;
  const body = { name:$('zone-name').value, notes:$('zone-notes').value, order:Number($('zone-order').value) };
  $('notes-dialog').close(); openZone(editing.id);
  await act(`/zones/${editing.id}/preferences`,body,'Saving zone details…');
});
document.querySelectorAll('[data-rain]').forEach(b => b.addEventListener('click', () => act('/rain',{ hours:Number(b.dataset.rain) })));
$('policy-mode').addEventListener('change', () => act('/policy',{ mode:$('policy-mode').value },'Saving weather mode…'));
document.addEventListener('visibilitychange', () => { document.body.classList.toggle('page-hidden',document.hidden); if (!document.hidden && !busy) load(); });
setInterval(() => { if (!document.hidden && !busy && !$('notes-dialog').open) load(); },5000);
setInterval(() => { if (!document.hidden) tick(); },1000);
load();
fetch('/healthz').then(r => r.json()).then(info => { $('demo-hint').hidden = info.mode !== 'demo'; }).catch(() => {});
