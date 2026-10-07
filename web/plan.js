// The Plan tab: what each zone needs, and the nights that follow from it.
// Advisory only. Edits save to the bridge's local store and never reach Tucor.
// Laid out for a phone first: a status line, a strip of nights, and a zone list.
// Each zone, the night window, and seasonal changes are edited in bottom sheets;
// anything that doesn't fit cleanly opens a review sheet before it saves.
import { CADENCES, DEFAULT_INTENT, NIGHTS, FALLBACK_SUNRISE, MAX_SECONDS, adjustedSeconds, addDays, cadenceKey, cadenceFromKey, cadenceLabel, currentNight, dateKey, durationText, formatDuration, parseDuration, resolvePlan, sunrise } from './planner.js';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NEEDS = new Set(['unset', 'duration', 'cadence']);
const STATUS = {
  ok: n => [`Done ${Math.round(n.sunrise - n.finish)} min before sunrise`, 'ok'],
  tight: n => [`Done ${Math.round(n.sunrise - n.finish)} min before sunrise`, 'warn'],
  late: n => [`Runs ${Math.round(n.finish - n.sunrise)} min past sunrise`, 'warn'],
  over: n => [`${n.deferred.length} zone${n.deferred.length > 1 ? 's don’t' : ' doesn’t'} fit`, 'bad'],
  rain: () => ['Rain hold', 'rain'],
  empty: () => ['Nothing due', ''],
};
const COMMON_CADENCES = [{ every: 1 }, { every: 2 }, { perWeek: 3 }, { perWeek: 2 }, { every: 7 }];
const PRESET_MINUTES = [5, 10, 15, 20, 30, 45, 60];
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

const clockAt = min => {
  const m = Math.round(min), h = Math.floor(m / 60) % 24, mm = m % 60;
  if (h === 0 && mm === 0) return 'midnight';
  return `${h % 12 || 12}:${String(mm).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
};
// 10:00pm → 10pm, for compact labels.
const clockShort = min => clockAt(min).replace(':00', '');
const short = seconds => seconds < 60 ? `${seconds}s` : seconds < 3600 ? seconds % 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : String(seconds / 60) : `${Math.floor(seconds / 3600)}h${Math.round(seconds % 3600 / 60) ? String(Math.round(seconds % 3600 / 60)).padStart(2, '0') : ''}`;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// Steps for the run-length buttons: fine for short runs, coarser for long ones.
const stepMinutes = (minutes, direction) => {
  const step = direction > 0 ? (minutes < 10 ? 1 : minutes < 60 ? 5 : 15) : (minutes <= 10 ? 1 : minutes <= 60 ? 5 : 15);
  const next = direction > 0 ? Math.floor(minutes / step) * step + step : Math.ceil(minutes / step) * step - step;
  return Math.max(1, Math.min(MAX_SECONDS / 60, next));
};
const clampPercent = value => Math.max(50, Math.min(200, Math.round(value)));

export function createPlan({ $, api, escape, message, html, getState, zoneEnabled }) {
  const drafts = new Map();          // zone id → intent shown before the server confirms it
  let pendingEdit = {}, editReview = null, editBusy = false, editError = '', observedFitKey = '', restoredDraft = false;
  try { const saved = JSON.parse(sessionStorage.getItem('2core-plan-draft') || '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) pendingEdit = saved; } catch { /* ignore unavailable storage */ }
  function rememberDraft() { try { Object.keys(pendingEdit).length ? sessionStorage.setItem('2core-plan-draft', JSON.stringify(pendingEdit)) : sessionStorage.removeItem('2core-plan-draft'); } catch { /* keep the in-memory draft */ } }
  let rebalanceProposal = null, reviewing = false;
  let seasonalEdited = false;
  let settingsDraft = null, selected = 0, needsOnly = false, whatIf = new Set(), rowsKey = '', stripKey = '';
  let latest = null;                 // the last resolved projection, for sheet summaries
  let sheet = null;                  // { id, intent } being edited in the zone sheet
  let showAllCadences = false;

  const zones = () => getState().zones.filter(z => z.configured);
  const intents = () => {
    const saved = getState().plan?.intents ?? {}, out = { ...saved };
    for (const [id, draft] of drafts) { if (same(saved[id], draft)) drafts.delete(id); else out[id] = draft; }
    return out;
  };
  const settings = () => {
    const saved = getState().plan?.settings;
    if (settingsDraft && same(saved, settingsDraft)) settingsDraft = null;
    return settingsDraft ?? saved;
  };
  const blank = () => ({ ...DEFAULT_INTENT });
  const zoneName = id => zones().find(z => z.id === id)?.name ?? `Zone ${id}`;
  const nightLabel = (start, d) => d === 0 ? 'Tonight' : d === 1 ? 'Tomorrow' : `${WD[addDays(start, d).getDay()]} ${addDays(start, d).getDate()}`;

  // A rain delay on the controller holds any night that starts before it ends.
  function rainNights(start, cfg) {
    const state = getState(), out = new Set(whatIf);
    const left = Number(state.status?.rainShutDown), seen = Date.parse(state.observedAt);
    if (left > 0 && Number.isFinite(seen)) {
      const until = seen + left * 1000;
      for (let d = 0; d < NIGHTS; d++) {
        const evening = addDays(start, d);
        if (until > evening.getTime() + cfg.earliestStart * 60000) out.add(dateKey(evening));
      }
    }
    return out;
  }
  function project(all = intents(), cfg = settings()) {
    const state = getState(), start = currentNight(), loc = state.location;
    const sunriseAt = loc ? date => sunrise(date, loc.latitude, loc.longitude) : () => null;
    return { start, plan: resolvePlan({ zones: zones(), intents: all, settings: cfg, start, rain: rainNights(start, cfg), sunriseAt }) };
  }

  /* ---------- drafts, checks and saving ---------- */
  const hasDraft = () => Object.keys(pendingEdit).length > 0;
  function stageIntent(id, patch) {
    pendingEdit.intents ??= {};
    pendingEdit.intents[id] = { ...pendingEdit.intents[id], ...patch };
    drafts.set(id, { ...blank(), ...intents()[id], ...patch });
    editReview = null; editError = ''; rememberDraft();
  }
  async function saveSettings(patch) {
    if (editBusy) return;
    pendingEdit.settings = { ...pendingEdit.settings, ...patch }; rememberDraft();
    settingsDraft = { ...settings(), ...patch };
    editReview = null; await checkDraft(true);
  }
  async function applyReviewed(alternativeId = null, saveUnresolved = false) {
    if (!editReview) return;
    const reviewed = editReview;
    editBusy = true; editError = ''; render();
    try {
      const result = await api('/plan/edit-apply', { change: reviewed.change, token: reviewed.token, alternativeId, saveUnresolved });
      for (const [id, intent] of Object.entries(result.plan.intents)) drafts.set(id, intent);
      settingsDraft = result.plan.settings;
      if (Object.values(reviewed.change.intents ?? {}).some(p => Object.hasOwn(p, 'enabled'))) $('rebalance-prompt').hidden = false;
      pendingEdit = {}; rememberDraft(); editReview = { ...reviewed, assessment: result.assessment, alternatives: [], plan: result.plan, change: {} };
      seasonalEdited = false;
      if ($('plan-review-dialog').open) $('plan-review-dialog').close();
      message(saveUnresolved ? 'Saved as an unfinished plan. The issue is still shown.' : alternativeId ? 'Saved with the adjustment.' : 'Saved.');
    } catch (e) {
      editError = `${e.message} Your change is kept. Check it again before saving.`;
      editReview = null;
    } finally { editBusy = false; render(); }
  }
  // Fitting changes save straight away; anything else opens the review sheet.
  async function checkDraft(autoSave = false) {
    if (editBusy) return;
    editBusy = true; editError = ''; render();
    try {
      const change = structuredClone(pendingEdit);
      const result = await api('/plan/edit-preview', { change });
      editReview = { ...result, change };
      // Use the server's normalized dates (including cadence changes) in the draft.
      if (hasDraft()) {
        for (const [id, intent] of Object.entries(result.plan.intents)) drafts.set(id, intent);
        settingsDraft = result.plan.settings;
      }
      if (autoSave && hasDraft() && result.assessment.status === 'fits') await applyReviewed();
    } catch (e) { editError = `Couldn’t check the plan: ${e.message}. Your change is kept.`; editReview = null; }
    finally { editBusy = false; render(); }
    if (autoSave && hasDraft()) openReview();
  }
  function discardDraft() {
    pendingEdit = {}; rememberDraft(); drafts.clear(); settingsDraft = null; editReview = null; editError = ''; seasonalEdited = false;
    if ($('plan-review-dialog').open) $('plan-review-dialog').close();
    checkDraft(false);
  }
  function openReview() {
    for (const id of ['plan-zone-dialog', 'plan-settings-dialog']) if ($(id).open) $(id).close();
    renderFit();
    if (!$('plan-review-dialog').open) $('plan-review-dialog').showModal();
  }

  /* ---------- status line and review sheet ---------- */
  const problemZones = () => new Set((editReview?.assessment?.scenarios ?? []).filter(r => r.status === 'needs-adjustment').flatMap(r => r.zoneIds ?? []));
  function consequenceText(r) {
    return [r.newParallelSeconds ? `${formatDuration(r.newParallelSeconds)} of two zones at once over fourteen nights.` : '', r.additionalOverlapSeconds ? `${formatDuration(r.additionalOverlapSeconds)} more time with two zones at once, over ${r.affectedNights} night${r.affectedNights === 1 ? '' : 's'}.` : '', r.laterFinishNights ? `Finishes later on ${r.laterFinishNights} night${r.laterFinishNights === 1 ? '' : 's'}; latest ${clockAt(r.latestFinish)}.` : '', r.afterPreferredNights ? `${r.afterPreferredNights} night${r.afterPreferredNights === 1 ? '' : 's'} finish after your target.` : ''].filter(Boolean).join(' ');
  }
  function problemText(r) {
    const names = (r.zoneIds ?? []).map(zoneName);
    return names.length ? `${names.join(', ')}: ${r.message}` : r.message;
  }
  function editLines() {
    const labels = { seconds: 'run length', cadence: 'how often', enabled: 'watering', waterDuringRain: 'water during rain', seasonalPercent: 'seasonal', firstDue: 'next watering' };
    const valueText = (key, value) => key === 'seconds' ? value == null ? 'not set' : formatDuration(value) : key === 'cadence' ? cadenceLabel(value) : key === 'seasonalPercent' ? `${value ?? 100}%` : typeof value === 'boolean' ? value ? 'on' : 'off' : String(value ?? 'not set');
    const lines = Object.entries(pendingEdit.intents ?? {}).flatMap(([id, patch]) => Object.entries(patch).map(([key, value]) => [zoneName(id), `${labels[key] ?? key} ${valueText(key, getState().plan.intents[id]?.[key])} → ${valueText(key, value)}`]));
    if (pendingEdit.seasonalPercent != null) lines.push(['All zones', `seasonal → ${pendingEdit.seasonalPercent}%`]);
    for (const [key, value] of Object.entries(pendingEdit.settings ?? {})) lines.push(['Night', key === 'lanes' ? `zones at once → ${value === 1 ? 'one' : 'up to two'}` : key === 'finishBeforeSunrise' ? `finish ${value ? `${value} min before sunrise` : 'by sunrise'}` : `${key === 'earliestStart' ? 'start after' : 'never past'} ${clockAt(value)}`]);
    if (pendingEdit.rebalanceToken) lines.push(['Dates', 'apply the reviewed rebalance']);
    if (pendingEdit.seasonalZoneIds) lines.push(['Seasonal comparison', 'update the zones it checks']);
    return lines;
  }
  function renderFit(plan) {
    const report = editReview?.assessment, draft = hasDraft();
    const status = editBusy ? 'busy' : editError ? 'error' : !report ? 'none' : report.status;
    const tone = { busy: '', error: 'danger', none: '', fits: 'leaf', consequence: 'amber', 'needs-adjustment': 'amber' }[status];
    const glyph = { error: 'alert', consequence: 'alert', 'needs-adjustment': 'alert' }[status] ?? 'check';

    // Status line on the page.
    const failing = report?.scenarios.find(r => r.status === 'needs-adjustment');
    const trade = report?.scenarios.map(consequenceText).find(Boolean);
    let title, detail = '';
    if (status === 'busy') title = draft ? 'Checking your change…' : 'Checking the plan…';
    else if (draft) { title = status === 'error' ? 'Couldn’t check your change' : status === 'none' ? 'Unsaved change' : status === 'fits' ? 'Your change fits · tap to save' : 'Unsaved change needs review'; detail = editLines().map(([who, what]) => `${who}: ${what}`).join(' · '); }
    else if (status === 'error') { title = 'Couldn’t check the plan'; detail = editError; }
    else if (status === 'needs-adjustment') { title = 'Needs an adjustment'; detail = problemText(failing); }
    else if (status === 'consequence') { title = 'Fits, with a trade-off'; detail = trade; }
    else title = status === 'fits' ? 'Fits overnight' : 'Watering plan';
    if (plan && !draft && (status === 'fits' || status === 'none' || status === 'busy')) {
      const planned = plan.zones.filter(z => !z.problem).length, open = plan.nights.filter(n => n.start != null);
      const last = open.reduce((a, n) => (!a || n.finish > a.finish ? n : a), null);
      detail = [`${planned} of ${plan.zones.length} zones planned`, last && `latest finish ${clockAt(last.finish)}`].filter(Boolean).join(' · ');
    }
    $('plan-status').dataset.tone = draft && status !== 'busy' ? 'draft' : tone;
    $('plan-status-icon').className = `badge-icon small ${draft && status !== 'busy' ? 'soft-water' : tone}`;
    $('plan-status-icon').innerHTML = icon(draft ? 'pencil' : glyph);
    $('plan-status-title').textContent = title;
    $('plan-status-detail').textContent = detail;

    // Review sheet.
    $('plan-fit-icon').className = `badge-icon small ${tone}`;
    $('plan-fit-icon').innerHTML = icon(glyph);
    $('plan-fit-title').textContent = status === 'busy' ? 'Checking…' : status === 'error' ? 'Couldn’t check' : status === 'none' ? (draft ? 'Unsaved change' : 'Watering plan check') : status === 'fits' ? (draft ? 'Your change fits' : 'Fits overnight') : status === 'consequence' ? 'Fits, with a trade-off' : 'Needs an adjustment';
    $('plan-fit-state').textContent = draft ? 'Not saved yet' : 'Saved plan';
    html('plan-fit-edit', editLines().map(([who, what]) => `<li><b>${escape(who)}</b><span>${escape(what)}</span></li>`).join(''));
    const scenarios = report?.scenarios ?? [];
    html('plan-fit-scenarios', scenarios.map(r => {
      const seasonal = r.id === 'current' ? '' : ` (${(editReview.seasonalZones ?? []).map(z => z.name).join(', ')})`;
      const text = r.status === 'needs-adjustment' ? problemText(r) : consequenceText(r) || `Fits ${r.maxConcurrent === 2 ? 'with up to two zones at once' : 'with one zone at a time'}.`;
      const fix = r.status === 'needs-adjustment' ? (r.zoneIds ?? []).map(id => `<button class="soft" data-fit-zone="${escape(id)}">${icon('pencil')}Edit ${escape(zoneName(id))}</button>`).join('') : '';
      return `<div class="fit-scenario ${r.status}">${scenarios.length > 1 ? `<b>${escape(r.label + seasonal)}</b>` : ''}<p>${escape(text)}${r.sunriseKnown === false ? ' Sunrise is estimated.' : ''}</p>${fix ? `<div class="fit-fixes">${fix}</div>` : ''}<details><summary>Details</summary><p>${escape(r.detail)}</p></details></div>`;
    }).join(''));
    html('plan-fit-alternatives', (editReview?.alternatives ?? []).length ? `<h3>Verified fixes</h3>${editReview.alternatives.map(a => `<article><p>${escape(a.description)}</p><button class="primary" data-fit-alternative="${a.id}"${editBusy ? ' disabled' : ''}>Use this and save</button></article>`).join('')}`
      : report?.status === 'needs-adjustment' && draft ? '<p class="hint">No verified fix found. Edit the change, or save it as an unfinished plan; this doesn’t prove your goal is impossible.</p>' : '');
    $('plan-fit-error').textContent = editError;
    $('fit-check').hidden = !draft || (report && !editError);
    $('fit-save').hidden = !draft || !report || report.status === 'needs-adjustment';
    $('fit-unfinished').hidden = !draft || report?.status !== 'needs-adjustment';
    $('fit-discard').hidden = !draft;
    for (const id of ['fit-check', 'fit-save', 'fit-unfinished', 'fit-discard']) $(id).disabled = editBusy;
    $('fit-save').textContent = report?.status === 'consequence' ? 'Save anyway' : 'Save';
  }
  $('plan-status').addEventListener('click', () => { if (hasDraft() && editReview?.assessment.status === 'fits' && !editBusy) applyReviewed(); else openReview(); });
  $('fit-close').addEventListener('click', () => $('plan-review-dialog').close());
  $('fit-check').addEventListener('click', () => checkDraft(false));
  $('fit-save').addEventListener('click', () => applyReviewed());
  $('fit-unfinished').addEventListener('click', () => applyReviewed(null, true));
  $('fit-discard').addEventListener('click', discardDraft);
  $('plan-review-dialog').addEventListener('click', e => {
    const alternative = e.target.closest('[data-fit-alternative]'), fix = e.target.closest('[data-fit-zone]');
    if (alternative && !editBusy) applyReviewed(alternative.dataset.fitAlternative);
    else if (fix) { $('plan-review-dialog').close(); openZone(fix.dataset.fitZone); }
  });

  /* ---------- page ---------- */
  function build(list) {
    $('plan-rows').innerHTML = list.map(z => `<button class="pz" data-row="${z.id}" data-plan-zone="${z.id}">
      <span class="zone-num num">${String(z.id).padStart(2, '0')}</span>
      <span class="pz-text"><b>${escape(z.name)}</b><small data-meta></small></span>
      <span class="pz-end"><span class="pnext" data-next></span><span class="pdots" data-cells aria-hidden="true"></span></span>
    </button>`).join('');
  }

  function render() {
    const state = getState();
    if (!state?.plan) return;
    if (!restoredDraft) {
      restoredDraft = true;
      if (hasDraft()) {
        for (const [id, patch] of Object.entries(pendingEdit.intents ?? {})) drafts.set(id, { ...blank(), ...state.plan.intents[id], ...patch });
        settingsDraft = { ...state.plan.settings, ...pendingEdit.settings };
        queueMicrotask(() => checkDraft(false));
      }
    }
    const fitKey = JSON.stringify([state.plan, state.location, dateKey(currentNight())]);
    if (!editBusy && !hasDraft() && fitKey !== observedFitKey) { observedFitKey = fitKey; queueMicrotask(() => checkDraft(false)); }
    const list = zones(), cfg = settings(), all = intents();
    const { start, plan } = project(all, cfg);
    latest = { start, plan, all };
    selected = Math.min(selected, NIGHTS - 1);
    const names = Object.fromEntries(list.map(z => [z.id, z.name]));

    renderFit(plan);
    renderSettings(cfg, list, all);

    // Filters
    const todo = plan.zones.filter(z => NEEDS.has(z.problem)).length;
    if (todo === 0) needsOnly = false;
    $('plan-all').setAttribute('aria-pressed', String(!needsOnly));
    $('plan-needs').setAttribute('aria-pressed', String(needsOnly));
    $('plan-needs').parentElement.hidden = todo === 0;
    $('plan-needs-count').textContent = todo;
    $('plan-needs-count').classList.toggle('hot', todo > 0);

    renderStrip(plan, start, cfg);
    renderNight(plan.nights[selected], selected, start, names, cfg);

    // Zone rows
    const key = list.map(z => `${z.id}:${z.name}`).join('|');
    if (key !== rowsKey) { rowsKey = key; build(list); }
    const byId = Object.fromEntries(plan.zones.map(z => [z.id, z])), flagged = problemZones();
    let shown = 0;
    for (const z of list) {
      const row = $('plan-rows').querySelector(`[data-row="${z.id}"]`), p = byId[z.id], intent = all[z.id] ?? blank();
      const hidden = needsOnly && !NEEDS.has(p.problem);
      row.hidden = hidden; if (!hidden) shown++;
      zoneEnabled(row, intent.enabled === false);
      const seconds = adjustedSeconds(intent), pct = intent.seasonalPercent ?? 100;
      const rhythm = `${formatDuration(seconds)} · ${cadenceLabel(intent.cadence)}${pct !== 100 ? ` · ${pct}%` : ''}`;
      const meta = p.problem === 'unset' ? ['Needs a run length and how often', 'warn']
        : p.problem === 'duration' ? [`${cadenceLabel(intent.cadence)} · add a run length`, 'warn']
        : p.problem === 'cadence' ? [`${formatDuration(seconds)} · choose how often`, 'warn']
        : p.problem === 'paused' ? ['Off for now · settings kept', '']
        : flagged.has(z.id) ? [`${rhythm} · needs adjustment`, 'warn']
        : [rhythm, ''];
      row.classList.toggle('todo', NEEDS.has(p.problem) || flagged.has(z.id));
      row.classList.toggle('tonight', p.cells[selected]?.kind === 'water');
      const metaEl = row.querySelector('[data-meta]');
      metaEl.textContent = meta[0]; metaEl.className = meta[1];
      const next = p.problem ? '' : p.next < 0 ? 'Later' : nightLabel(start, p.next);
      const nextEl = row.querySelector('[data-next]');
      nextEl.textContent = next;
      nextEl.classList.toggle('soon', p.next === 0 && !p.problem);
      const dots = p.problem ? '' : p.cells.map((c, d) => `<i class="${c.kind}${c.late ? ' late' : ''}${d === selected ? ' sel' : ''}"></i>`).join('');
      const cells = row.querySelector('[data-cells]');
      if (cells._html !== dots) { cells.innerHTML = dots; cells._html = dots; }
      row.setAttribute('aria-label', `${z.name}. ${meta[0]}.${next ? ` Next: ${next}.` : ''} Edit schedule`);
    }
    $('plan-empty').hidden = shown > 0;
    $('plan-empty').textContent = needsOnly ? 'Every zone has a plan.' : 'No named zones yet. Check the controller connection.';
    if (sheet) renderZoneSheet();
  }

  function renderStrip(plan, start, cfg) {
    const span = cfg.hardDeadline + 1440 - cfg.earliestStart;
    const strip = plan.nights.map((n, d) => {
      const date = addDays(start, d);
      const fill = n.start == null ? 0 : Math.max(8, Math.min(100, Math.round((n.finish - n.start) / span * 100)));
      const label = n.status === 'rain' ? 'rain hold' : n.status === 'over' ? `${n.deferred.length} don’t fit` : n.start == null ? 'nothing due' : `done ${clockAt(n.finish)}`;
      return `<button class="nd ${n.status}${d === selected ? ' sel' : ''}" data-night="${d}" aria-pressed="${d === selected}" aria-label="${WEEKDAY[date.getDay()]} ${MONTH[date.getMonth()]} ${date.getDate()}: ${label}"><small>${d === 0 ? 'Tonight' : WD[date.getDay()]}</small><b class="num">${date.getDate()}</b><span class="bar">${n.rain ? icon('rain') : `<i data-width="${fill}"></i>`}</span></button>`;
    }).join('');
    html('plan-nights', strip);
    place($('plan-nights'));
    // Keep the chosen night in view when it changes, without fighting a user's scroll.
    const key = `${dateKey(start)}:${selected}`;
    if (key !== stripKey) {
      stripKey = key;
      const button = $('plan-nights').querySelector('.sel'), box = $('plan-nights');
      if (button && box.clientWidth) box.scrollTo({ left: Math.max(0, button.offsetLeft - box.clientWidth / 2 + button.offsetWidth / 2), behavior: 'smooth' });
    }
  }

  function renderNight(n, d, start, names, cfg) {
    const date = addDays(start, d), morning = addDays(start, d + 1);
    const lo = Math.min(n.earliestStart, n.start ?? Infinity) - 15, hi = Math.max(n.hardDeadline, n.sunrise) + 15, span = hi - lo;
    const pos = m => Math.max(0, Math.min(100, (m - lo) / span * 100)).toFixed(3);
    const [status, tone] = STATUS[n.status](n);
    const ticks = [];
    for (let m = Math.ceil(lo / 180) * 180; m <= hi; m += 180) ticks.push(`<span data-left="${pos(m)}">${clockShort(m)}</span>`);
    const tracks = (n.lanes[1]?.length ? [0, 1] : [0]).map(i => `<div class="track">${(n.lanes[i] ?? []).map(r => `<i class="run${r.late ? ' late' : ''}" data-left="${pos(r.from)}" data-width="${((r.to - r.from) / span * 100).toFixed(3)}"></i>`).join('')}</div>`).join('');
    const runs = n.lanes.flatMap((lane, i) => lane.map(r => ({ ...r, lane: i }))).sort((a, b) => a.from - b.from);
    const notes = [
      ...(n.held.length ? [['rain', `${n.held.map(id => names[id]).join(', ')} ${n.held.length > 1 ? 'wait' : 'waits'} for the next clear night.`]] : []),
      ...(n.rain && n.start != null ? [['rain', 'Covered zones keep their planned watering during rain. This preview does not bypass the controller’s rain delay.']] : []),
      ...Object.values(Object.groupBy(n.late, l => `${l.nights}:${l.reason}`)).map(group => {
        const { nights, reason } = group[0], who = group.map(l => names[l.zone]).join(', ');
        return ['warn', `${who} ${group.length > 1 ? 'water' : 'waters'} ${nights} night${nights > 1 ? 's' : ''} late after ${reason === 'rain' ? 'waiting out rain' : 'not fitting an earlier night'}.`];
      }),
      ...n.deferred.map(id => ['bad', `${names[id]} doesn’t fit and waits for the next night.`]),
      ...(n.needMinutes ? [['bad', `This night needs at least ${formatDuration(n.needMinutes * 60)} more, an earlier start, a later deadline, or another zone at once.`]] : []),
    ];
    if (!n.sunriseKnown) notes.push(['', `Sunrise is unknown until the Tempest reports its location, so the plan aims for ${clockAt(1440 + FALLBACK_SUNRISE - cfg.finishBeforeSunrise)}.`]);
    const tried = whatIf.has(n.date), held = n.rain && !tried;
    html('night-card', `
      <div class="night-head">
        <div><p class="muted">${WD[date.getDay()]} ${MONTH[date.getMonth()]} ${date.getDate()} → ${WD[morning.getDay()]} morning</p><h2>${d === 0 ? 'Tonight' : d === 1 ? 'Tomorrow night' : `${WEEKDAY[date.getDay()]} night`}</h2></div>
        <span class="pill ${tone}"><i class="dot"></i>${status}</span>
      </div>
      ${n.start == null ? '' : `<dl class="night-stats num">
        <div><dt>Starts</dt><dd>${clockAt(n.start)}</dd></div>
        <div><dt>Done</dt><dd>${clockAt(n.finish)}</dd></div>
        <div><dt>Water</dt><dd title="${formatDuration(n.seconds)}">${short(n.seconds)}</dd></div>
        <div><dt>Zones</dt><dd>${runs.length}</dd></div>
      </dl>`}
      <div class="night-bar" aria-hidden="true">
        <div class="tracks"><i class="window-before" data-width="${pos(n.earliestStart)}"></i><i class="window-after" data-left="${pos(n.hardDeadline)}"></i>${tracks}<i class="mark aim" data-left="${pos(n.preferredFinish)}"></i><i class="mark sun" data-left="${pos(n.sunrise)}"></i></div>
        <div class="axis num">${ticks.join('')}</div>
      </div>
      <p class="night-legend num"><span><i class="k-aim"></i>Aim ${clockAt(n.preferredFinish)}</span><span><i class="k-sun"></i>Sunrise ${clockAt(n.sunrise)}</span><span><i class="k-hard"></i>Never past ${clockAt(n.hardDeadline)}</span></p>
      ${runs.length ? `<ol class="night-runs">${runs.map(r => `<li><button data-plan-zone="${escape(r.zone)}"><span class="num">${clockAt(r.from)}</span><b>${escape(names[r.zone])}</b><small class="num">${formatDuration(r.seconds)}${r.late ? ` · ${r.late} late` : ''}</small>${r.lane ? '<em>2nd zone</em>' : ''}</button></li>`).join('')}</ol>`
        : `<p class="night-empty">${n.rain ? 'Rain hold · nothing waters this night' : n.deferred.length ? 'Nothing fits this night' : 'Nothing is due this night'}</p>`}
      ${notes.length ? `<ul class="night-notes">${notes.map(([tone, text]) => `<li class="${tone}">${escape(text)}</li>`).join('')}</ul>` : ''}
      ${held ? '<p class="hint">The controller’s rain delay covers this night.</p>' : `<button class="chip try-rain" data-whatif="${n.date}" aria-pressed="${tried}">${icon('rain')}${tried ? 'Rain hold on · tap to clear' : 'What if it rains?'}</button>`}`);
    place($('night-card'));
  }

  function renderSettings(cfg, list, all) {
    $('plan-window').textContent = `${clockShort(cfg.earliestStart)}–${clockShort(cfg.hardDeadline + 1440)}`;
    const percentages = new Set(list.map(z => all[z.id]?.seasonalPercent ?? 100));
    const commonPercent = percentages.size === 1 ? [...percentages][0] : null;
    $('seasonal-status').textContent = editBusy && Object.hasOwn(pendingEdit, 'seasonalPercent') ? '…' : commonPercent == null ? 'Mixed' : `${commonPercent}%`;
    if (!seasonalEdited && document.activeElement !== $('seasonal-all')) $('seasonal-all').value = commonPercent ?? '';
    $('seasonal-all').placeholder = 'Mixed';
    for (const id of ['seasonal-all', 'seasonal-apply']) $(id).disabled = editBusy || !list.length;
    for (const [id, k] of [['plan-earliest', 'earliestStart'], ['plan-finish', 'finishBeforeSunrise'], ['plan-hard', 'hardDeadline']]) {
      const select = $(id), value = String(cfg[k]);
      if (![...select.options].some(o => o.value === value)) select.add(new Option(k === 'finishBeforeSunrise' ? `${cfg[k]} min before sunrise` : clockAt(cfg[k]), value));
      if (document.activeElement !== select) select.value = value;
      select.disabled = editBusy;
    }
    document.querySelectorAll('[data-lanes]').forEach(b => { b.setAttribute('aria-checked', String(Number(b.dataset.lanes) === cfg.lanes)); b.disabled = editBusy; });
    for (const id of ['plan-rebalance', 'review-rebalance', 'plan-programs']) $(id).disabled = editBusy || hasDraft();
    const selectedIds = pendingEdit.seasonalZoneIds ?? editReview?.plan?.seasonalZoneIds ?? getState().plan.seasonalZoneIds ?? [];
    html('fit-seasonal-zones', list.map(z => `<label><input type="checkbox" data-fit-seasonal="${z.id}"${selectedIds.includes(z.id) ? ' checked' : ''}${editBusy ? ' disabled' : ''}>${escape(z.name)}</label>`).join(''));
  }

  /* ---------- zone sheet ---------- */
  function openZone(id) {
    const zone = zones().find(z => z.id === id);
    if (!zone || !getState()?.plan) return;
    sheet = { id, intent: { ...blank(), ...intents()[id] }, typed: null };
    showAllCadences = Boolean(sheet.intent.cadence) && !COMMON_CADENCES.some(c => cadenceKey(c) === cadenceKey(sheet.intent.cadence));
    $('pz-error').textContent = '';
    $('pz-minutes').value = durationText(sheet.intent.seconds);
    $('pz-seasonal').value = sheet.intent.seasonalPercent ?? 100;
    renderZoneSheet();
    if (!$('plan-zone-dialog').open) $('plan-zone-dialog').showModal();
  }
  function sheetPatch() {
    const saved = { ...blank(), ...intents()[sheet.id] }, patch = {};
    for (const key of ['seconds', 'cadence', 'enabled', 'waterDuringRain', 'seasonalPercent']) if (!same(saved[key], sheet.intent[key])) patch[key] = sheet.intent[key];
    return patch;
  }
  function renderZoneSheet() {
    const zone = zones().find(z => z.id === sheet.id);
    if (!zone) { $('plan-zone-dialog').close(); return; }
    const intent = sheet.intent, on = intent.enabled !== false;
    $('pz-number').textContent = String(zone.id).padStart(2, '0');
    $('pz-name').textContent = zone.name;
    $('pz-enabled').checked = on;
    $('pz-fields').classList.toggle('off', !on);
    $('pz-minutes').closest('.stepper').classList.toggle('invalid', sheet.typed != null);
    html('pz-presets', PRESET_MINUTES.map(m => `<button type="button" data-preset="${m}" aria-pressed="${intent.seconds === m * 60}">${m}</button>`).join(''));
    const choices = showAllCadences ? CADENCES : COMMON_CADENCES;
    const offered = intent.cadence && !choices.some(c => cadenceKey(c) === cadenceKey(intent.cadence)) ? [...choices, intent.cadence] : choices;
    html('pz-cadence', offered.map(c => `<button type="button" role="radio" data-cadence="${cadenceKey(c)}" aria-checked="${cadenceKey(c) === cadenceKey(intent.cadence)}">${cadenceLabel(c)}</button>`).join('')
      + (showAllCadences ? '' : '<button type="button" class="more" data-cadence="more">More…</button>'));
    // The controller repeats on a fourteen-day calendar; say so before the check does.
    $('pz-cadence-hint').textContent = intent.cadence?.every && 14 % intent.cadence.every ? `The controller repeats every two weeks, so “${cadenceLabel(intent.cadence)}” can’t be installed exactly. Every 2 days, 2–3× a week, or weekly can.` : '';
    const pct = intent.seasonalPercent ?? 100, adjusted = adjustedSeconds(intent);
    $('pz-seasonal-hint').textContent = !intent.seconds ? 'Scales the run length for the season.' : pct === 100 ? 'Runs at the full length.' : `Runs ${formatDuration(adjusted)} instead of ${formatDuration(intent.seconds)}.`;
    $('pz-rain').checked = intent.waterDuringRain === true;
    // Preview this zone with the unsaved values to show what they mean.
    const preview = project({ ...intents(), [sheet.id]: intent }).plan.zones.find(z => z.id === sheet.id);
    $('pz-summary').textContent = sheet.typed != null ? 'Enter a run length from 1 second to 4 hours'
      : preview?.problem === 'paused' ? 'Off · settings kept'
      : preview?.problem ? 'Needs a run length and how often'
      : `≈ ${formatDuration(Math.round(preview.weeklySeconds / 60) * 60)} a week · next ${preview.next < 0 ? 'in more than two weeks' : nightLabel(latest.start, preview.next).toLowerCase()}`;
    const changed = Object.keys(sheetPatch()).length > 0;
    $('pz-save').disabled = editBusy || sheet.typed != null || !changed;
    $('pz-save').textContent = editBusy ? 'Checking…' : 'Save';
  }
  function setSheetMinutes(seconds, fromTyping = false) {
    sheet.intent.seconds = seconds; sheet.typed = null;
    if (!fromTyping) $('pz-minutes').value = durationText(seconds);
    renderZoneSheet();
  }
  function setSheetPercent(value) {
    sheet.intent.seasonalPercent = clampPercent(value);
    $('pz-seasonal').value = sheet.intent.seasonalPercent;
    renderZoneSheet();
  }
  $('plan-zone-dialog').addEventListener('click', e => {
    if (!sheet) return;
    const step = e.target.closest('[data-step]'), preset = e.target.closest('[data-preset]'), cadence = e.target.closest('[data-cadence]');
    if (step) {
      const [field, dir] = step.dataset.step.split(':'), direction = Number(dir);
      if (field === 'minutes') setSheetMinutes(sheet.intent.seconds ? stepMinutes(sheet.intent.seconds / 60, direction) * 60 : 600);
      else setSheetPercent((sheet.intent.seasonalPercent ?? 100) + direction * 5);
    } else if (preset) setSheetMinutes(Number(preset.dataset.preset) * 60);
    else if (cadence) {
      if (cadence.dataset.cadence === 'more') showAllCadences = true;
      else sheet.intent.cadence = cadenceFromKey(cadence.dataset.cadence);
      renderZoneSheet();
    }
  });
  $('pz-minutes').addEventListener('input', () => {
    const seconds = parseDuration($('pz-minutes').value);
    if (seconds == null) { sheet.intent.seconds = null; sheet.typed = null; renderZoneSheet(); return; }
    if (Number.isNaN(seconds) || seconds > MAX_SECONDS || seconds === 0) { sheet.typed = $('pz-minutes').value; renderZoneSheet(); return; }
    setSheetMinutes(seconds, true);
  });
  $('pz-minutes').addEventListener('change', () => { if (sheet.typed == null) $('pz-minutes').value = durationText(sheet.intent.seconds); });
  $('pz-seasonal').addEventListener('change', () => { const value = Number($('pz-seasonal').value); setSheetPercent(Number.isFinite(value) && $('pz-seasonal').value !== '' ? value : 100); });
  $('pz-enabled').addEventListener('change', () => { sheet.intent.enabled = $('pz-enabled').checked; renderZoneSheet(); });
  $('pz-rain').addEventListener('change', () => { sheet.intent.waterDuringRain = $('pz-rain').checked; renderZoneSheet(); });
  $('pz-cancel').addEventListener('click', () => $('plan-zone-dialog').close());
  $('pz-close').addEventListener('click', () => $('plan-zone-dialog').close());
  $('plan-zone-dialog').addEventListener('close', () => { sheet = null; });
  $('pz-save').addEventListener('click', async () => {
    if (!sheet || editBusy || sheet.typed != null) return;
    const patch = sheetPatch(), id = sheet.id;
    if (!Object.keys(patch).length) { $('plan-zone-dialog').close(); return; }
    stageIntent(id, patch);
    $('plan-zone-dialog').close();
    await checkDraft(true);
  });

  /* ---------- settings sheet ---------- */
  function openSettings(section) {
    renderSettings(settings(), zones(), intents());
    $('plan-settings-dialog').showModal();
    if (section) $(section).scrollIntoView({ block: 'start' });
  }
  $('plan-open-night').addEventListener('click', () => openSettings('settings-night'));
  $('plan-open-seasonal').addEventListener('click', () => openSettings('settings-seasonal'));
  $('plan-open-settings').addEventListener('click', () => openSettings());
  $('close-plan-settings').addEventListener('click', () => $('plan-settings-dialog').close());
  const settingsSheet = $('plan-settings-dialog');
  settingsSheet.addEventListener('click', e => {
    const lanes = e.target.closest('[data-lanes]'), step = e.target.closest('[data-step]');
    if (lanes && lanes.getAttribute('aria-checked') !== 'true') saveSettings({ lanes: Number(lanes.dataset.lanes) });
    else if (step) {
      const value = Number($('seasonal-all').value) || 100;
      $('seasonal-all').value = clampPercent(value + Number(step.dataset.step.split(':')[1]) * 5); seasonalEdited = true;
    }
  });
  settingsSheet.addEventListener('change', e => {
    if (e.target.id === 'plan-earliest') saveSettings({ earliestStart: Number(e.target.value) });
    else if (e.target.id === 'plan-finish') saveSettings({ finishBeforeSunrise: Number(e.target.value) });
    else if (e.target.id === 'plan-hard') saveSettings({ hardDeadline: Number(e.target.value) });
    else if (e.target.matches('[data-fit-seasonal]') && !editBusy) {
      pendingEdit.seasonalZoneIds = [...$('fit-seasonal-zones').querySelectorAll('input:checked')].map(i => i.dataset.fitSeasonal);
      rememberDraft(); editReview = null; checkDraft(true);
    }
  });
  $('seasonal-all').addEventListener('input', () => { seasonalEdited = true; });
  $('seasonal-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!$('seasonal-all').reportValidity()) return;
    const seasonalPercent = Number($('seasonal-all').value);
    if (editBusy) return;
    // A later all-zones adjustment supersedes earlier per-zone percentage drafts.
    for (const [id, patch] of Object.entries(pendingEdit.intents ?? {})) {
      delete patch.seasonalPercent;
      if (!Object.keys(patch).length) delete pendingEdit.intents[id];
    }
    if (pendingEdit.intents && !Object.keys(pendingEdit.intents).length) delete pendingEdit.intents;
    pendingEdit.seasonalPercent = seasonalPercent; rememberDraft();
    for (const z of zones()) drafts.set(z.id, { ...blank(), ...intents()[z.id], seasonalPercent });
    editReview = null;
    await checkDraft(true);
  });

  /* ---------- rebalance and program preview ---------- */
  async function reviewRebalance() {
    if (reviewing) return;
    reviewing = true;
    try {
      rebalanceProposal = await api('/plan/rebalance-preview', {});
      const p = rebalanceProposal, names = Object.fromEntries(zones().map(z => [z.id, z.name]));
      const pretty = key => { const [, m, d] = key.split('-').map(Number); return `${MONTH[m - 1]} ${d}`; };
      $('rebalance-summary').textContent = p.changes.length
        ? `Move ${p.changes.length} zone${p.changes.length === 1 ? '' : 's'}. Over the next 12 weeks, the busiest night drops from ${formatDuration(p.beforePeakSeconds)} to ${formatDuration(p.afterPeakSeconds)} of watering.`
        : 'No useful rebalance found. Watering dates can stay as they are.';
      $('rebalance-changes').innerHTML = p.changes.map(c => `<li><b>${escape(names[c.zone] ?? `Zone ${c.zone}`)}</b><span class="num">${pretty(c.before)} → ${pretty(c.after)}</span><small>${Math.abs(c.days)} day${Math.abs(c.days) === 1 ? '' : 's'} ${c.days > 0 ? 'later — a longer wait this time' : 'earlier — a shorter gap this time'}, then the usual rhythm.</small></li>`).join('');
      $('rebalance-error').textContent = '';
      $('confirm-rebalance').hidden = !p.changes.length;
      $('confirm-rebalance').disabled = false;
      $('cancel-rebalance').textContent = p.changes.length ? 'Keep current dates' : 'Close';
      if ($('plan-settings-dialog').open) $('plan-settings-dialog').close();
      $('rebalance-dialog').showModal();
    } catch (e) { message(`Couldn’t prepare the rebalance: ${e.message}`, true); }
    finally { reviewing = false; }
  }
  function programReport(p, title) {
    const stats = p.summary;
    const summary = `${stats.zones} zones · ${stats.programs} of 10 programs · ${formatDuration(stats.weeklySeconds)} a week`;
    if (p.status !== 'candidate') return `<section class="program-report"><h3>${escape(title)}</h3><p class="muted">${summary}</p><p>No complete candidate yet.</p><ul>${p.issues.map(i => `<li>${escape(i.message)}</li>`).join('')}</ul></section>`;
    return `<section class="program-report"><h3>${escape(title)}</h3><p class="muted">${summary}</p>
      <p>${stats.maxConcurrent <= 1 ? 'One zone at a time.' : `Up to ${stats.maxConcurrent} zones at once; ${formatDuration(stats.parallelSeconds)} of overlap across 14 nights.`} ${stats.minimumOverlapProven ? 'Minimum overlap for this window.' : 'Overlap may be reducible.'} ${stats.preferredWindowMet ? 'Fits before' : 'Uses time after'} the ${clockAt(p.horizon.preferredFinish)} target.${p.horizon.sunriseKnown ? '' : ' Sunrise is estimated.'}</p>
      <ol class="programs">${p.programs.map(g => `<li><div class="program-head"><b>Program ${escape(g.slot)}</b><span class="num">${clockAt(g.startMinute)}${g.startDayOffset ? ' (+1 day)' : ''} · ${formatDuration(g.seconds)}</span></div>${g.waterDuringRain ? '<small>Waters during rain</small>' : ''}<p>${g.steps.map(s => `${escape(s.name)} <span class="num">${formatDuration(s.seconds)}</span>`).join(' → ')}</p><small class="num">${g.eveningMask.map((on, d) => on ? p.dates[d].slice(5).replace('-', '/') : null).filter(Boolean).join(', ')}</small></li>`).join('')}</ol>
      <details><summary>Night-by-night totals</summary><ul>${p.nights.map(n => `<li class="num">${n.date.slice(5).replace('-', '/')}: ${formatDuration(n.seconds)}${n.start == null ? '' : `, ${clockAt(n.start)}–${clockAt(n.finish)}`}${n.parallelSeconds ? `; ${formatDuration(n.parallelSeconds)} overlap` : ''}</li>`).join('')}</ul></details>
      <details><summary>Controller assumptions still to verify</summary><ul>${p.assumptions.map(a => `<li>${escape(a)}</li>`).join('')}</ul></details></section>`;
  }
  async function previewPrograms(compare = false) {
    $('program-error').textContent = 'Compiling the saved plan…';
    $('compare-programs').disabled = true;
    $('program-results').innerHTML = '';
    try {
      const base = await api('/plan/program-preview', {});
      let reports = programReport(base, 'Saved plan');
      if (compare) {
        const enabledOverrides = Object.fromEntries([...$('program-overrides').querySelectorAll('input:checked')].map(i => [i.value, true]));
        if (Object.keys(enabledOverrides).length) reports += programReport(await api('/plan/program-preview', { enabledOverrides }), 'With selected zones on');
      }
      $('program-results').innerHTML = reports;
      $('program-error').textContent = '';
    } catch (e) { $('program-error').textContent = `Couldn’t compile: ${e.message}`; }
    finally { $('compare-programs').disabled = false; }
  }
  $('plan-programs').addEventListener('click', () => {
    const paused = zones().filter(z => intents()[z.id]?.enabled === false);
    $('program-overrides').innerHTML = paused.length ? `<legend>Compare with zones that are off for now</legend>${paused.map(z => `<label><input type="checkbox" value="${escape(z.id)}" checked>${escape(z.name)}</label>`).join('')}` : '';
    $('program-overrides').hidden = !paused.length;
    $('compare-programs').hidden = !paused.length;
    $('plan-settings-dialog').close();
    $('program-dialog').showModal(); previewPrograms(Boolean(paused.length));
  });
  $('compare-programs').addEventListener('click', () => previewPrograms(true));
  $('close-programs').addEventListener('click', () => $('program-dialog').close());

  $('plan-rebalance').addEventListener('click', reviewRebalance);
  $('review-rebalance').addEventListener('click', reviewRebalance);
  $('dismiss-rebalance').addEventListener('click', () => { $('rebalance-prompt').hidden = true; });
  for (const id of ['cancel-rebalance', 'close-rebalance']) $(id).addEventListener('click', () => $('rebalance-dialog').close());
  $('confirm-rebalance').addEventListener('click', async () => {
    if (!rebalanceProposal) return;
    $('confirm-rebalance').disabled = true;
    try {
      pendingEdit.rebalanceToken = rebalanceProposal.token; rememberDraft();
      $('rebalance-dialog').close();
      $('rebalance-prompt').hidden = true;
      rebalanceProposal = null; editReview = null;
      await checkDraft(true);
    } catch (e) { $('rebalance-error').textContent = `${e.message} Close this review and review again before confirming.`; }
  });

  // The page's CSP forbids inline style attributes; position through the DOM.
  function place(root) {
    root.querySelectorAll('[data-left]').forEach(el => { el.style.left = `${el.dataset.left}%`; });
    root.querySelectorAll('[data-width]').forEach(el => { el.style.width = `${el.dataset.width}%`; });
  }

  $('plan-view').addEventListener('click', e => {
    const night = e.target.closest('[data-night]'), rain = e.target.closest('[data-whatif]'), zone = e.target.closest('[data-plan-zone]');
    if (night) { selected = Number(night.dataset.night); render(); }
    else if (rain) { whatIf.has(rain.dataset.whatif) ? whatIf.delete(rain.dataset.whatif) : whatIf.add(rain.dataset.whatif); render(); }
    else if (zone) openZone(zone.dataset.planZone);
    else if (e.target.closest('#plan-all')) { needsOnly = false; render(); }
    else if (e.target.closest('#plan-needs')) { needsOnly = true; render(); }
  });

  // One line for the zone sheet on the Zones tab.
  function describeZone(id) {
    const state = getState();
    if (!state?.plan || !zones().some(z => z.id === id)) return null;
    const intent = { ...blank(), ...intents()[id] };
    const p = (latest?.plan ?? project().plan).zones.find(z => z.id === id), start = latest?.start ?? currentNight();
    if (p?.problem === 'paused') return 'Off for now';
    if (p?.problem) return 'Not planned yet · tap to set it up';
    return `${formatDuration(adjustedSeconds(intent))} · ${cadenceLabel(intent.cadence)} · next ${p.next < 0 ? 'later' : nightLabel(start, p.next).toLowerCase()}`;
  }

  return { render, openZone, describeZone };
}
