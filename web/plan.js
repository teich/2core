// The Plan tab: what each zone needs, and the nights that follow from it.
// Advisory only. Edits save to the bridge's local store and never reach Tucor.
import { CADENCES, DEFAULT_INTENT, NIGHTS, FALLBACK_SUNRISE, adjustedSeconds, addDays, cadenceFromKey, cadenceKey, cadenceLabel, currentNight, dateKey, formatDuration, parseDuration, resolvePlan, sunrise } from './planner.js';

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
const RAIN_ICON = '<svg aria-hidden="true"><use href="#i-rain"/></svg>';

const clockAt = min => {
  const m = Math.round(min), h = Math.floor(m / 60) % 24, mm = m % 60;
  if (h === 0 && mm === 0) return 'midnight';
  return `${h % 12 || 12}:${String(mm).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
};
const short = seconds => seconds < 60 ? `${seconds}s` : seconds < 3600 ? seconds % 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : String(seconds / 60) : `${Math.floor(seconds / 3600)}h${Math.round(seconds % 3600 / 60) ? String(Math.round(seconds % 3600 / 60)).padStart(2, '0') : ''}`;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function createPlan({ $, api, escape, message, html, getState, zoneEnabled }) {
  const drafts = new Map();          // zone id → intent shown before the server confirms it
  let pendingEdit = {}, editReview = null, editBusy = false, editError = '', observedFitKey = '', restoredDraft = false;
  try { const saved = JSON.parse(sessionStorage.getItem('2core-plan-draft') || '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) pendingEdit = saved; } catch { /* ignore unavailable storage */ }
  function rememberDraft() { try { Object.keys(pendingEdit).length ? sessionStorage.setItem('2core-plan-draft', JSON.stringify(pendingEdit)) : sessionStorage.removeItem('2core-plan-draft'); } catch { /* keep the in-memory draft */ } }
  let rebalanceProposal = null, reviewing = false;
  let seasonalEdited = false;
  const expandedCadences = new Set();
  const typed = new Map();           // zone id → unreadable duration text, kept so it can be fixed
  let settingsDraft = null, selected = 0, needsOnly = false, whatIf = new Set(), rowsKey = '';

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

  const hasDraft = () => Object.keys(pendingEdit).length > 0;
  function stageIntent(id, patch) {
    pendingEdit.intents ??= {};
    pendingEdit.intents[id] = { ...pendingEdit.intents[id], ...patch };
    drafts.set(id, { ...blank(), ...intents()[id], ...patch });
    editReview = null; editError = ''; rememberDraft();
  }
  async function saveIntent(id, patch) {
    if (editBusy) return;
    stageIntent(id, patch);
    await checkDraft(true);
  }
  async function saveSettings(patch) {
    if (editBusy) return;
    pendingEdit.settings = { ...pendingEdit.settings, ...patch }; rememberDraft();
    settingsDraft = { ...settings(), ...patch };
    editReview = null; await checkDraft(true);
  }
  async function applyReviewed(alternativeId = null, saveUnresolved = false) {
    if (!editReview || typed.size) return;
    const reviewed = editReview;
    editBusy = true; editError = ''; render();
    try {
      const result = await api('/plan/edit-apply', { change: reviewed.change, token: reviewed.token, alternativeId, saveUnresolved });
      for (const [id, intent] of Object.entries(result.plan.intents)) drafts.set(id, intent);
      settingsDraft = result.plan.settings;
      if (Object.values(reviewed.change.intents ?? {}).some(p => Object.hasOwn(p, 'enabled'))) $('rebalance-prompt').hidden = false;
      pendingEdit = {}; rememberDraft(); editReview = { ...reviewed, assessment: result.assessment, alternatives: [], plan: result.plan, change: {} };
      seasonalEdited = false;
      message(saveUnresolved ? 'Saved as an unfinished plan. The fit issue is still shown.' : 'Saved the reviewed watering plan.');
    } catch (e) {
      editError = `${e.message} Your draft is kept. Check it again before saving.`;
      editReview = null;
    } finally { editBusy = false; render(); }
  }
  async function checkDraft(autoSave = false) {
    if (editBusy) return;
    if (typed.size) { editError = 'Fix the marked run lengths before checking or saving this draft.'; render(); return; }
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
      else if (autoSave && hasDraft()) $('plan-fit').scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (e) { editError = `Couldn’t check the plan: ${e.message}. Your draft is kept.`; editReview = null; }
    finally { editBusy = false; render(); }
  }
  function renderFit() {
    const report = editReview?.assessment, draft = hasDraft();
    $('plan-fit-title').textContent = editBusy ? 'Checking your watering plan…' : !report ? (draft ? 'Unsaved watering draft' : 'Watering plan check') : report.status === 'fits' ? 'Your watering plan fits overnight' : report.status === 'consequence' ? 'Fits with a consequence' : 'Needs an adjustment';
    $('plan-fit-state').textContent = `${draft ? 'Draft kept — not saved yet.' : 'Saved intentions.'} These are dry-weather checks for the next fourteen nights, not a controller installation. Rainfall and future seasonal dates need their own review.`;
    const labels = { seconds: 'run length', cadence: 'frequency', enabled: 'watering', waterDuringRain: 'water during rain', seasonalPercent: 'seasonal percentage', firstDue: 'watering date' };
    const valueText = (key, value) => key === 'seconds' ? value == null ? 'not set' : formatDuration(value) : key === 'cadence' ? cadenceLabel(value) : typeof value === 'boolean' ? value ? 'on' : 'off' : String(value ?? 'not set');
    const edits = Object.entries(pendingEdit.intents ?? {}).flatMap(([id, patch]) => Object.entries(patch).map(([key, value]) => `${zones().find(z => z.id === id)?.name ?? id}: ${labels[key] ?? key} ${valueText(key, getState().plan.intents[id]?.[key])} → ${valueText(key, value)}`));
    if (pendingEdit.seasonalPercent != null) edits.push(`All zones: seasonal percentage → ${pendingEdit.seasonalPercent}%`);
    for (const [key, value] of Object.entries(pendingEdit.settings ?? {})) edits.push(key === 'lanes' ? `Maximum zones at once → ${value}` : key === 'finishBeforeSunrise' ? `Finish target → ${value} minutes before sunrise` : `${key === 'earliestStart' ? 'Earliest start' : 'Latest finish'} → ${clockAt(value)}`);
    if (pendingEdit.rebalanceToken) edits.push('Apply the watering-date changes from your rebalance review.');
    if (pendingEdit.seasonalZoneIds) edits.push('Update which zones are included in the seasonal comparison.');
    $('plan-fit-edit').textContent = edits.join(' · ');
    $('plan-fit-error').textContent = editError;
    html('plan-fit-scenarios', (report?.scenarios ?? []).map(r => {
      const seasonal = r.id === 'current' ? '' : ` (${(editReview.seasonalZones ?? []).map(z => z.name).join(', ')})`;
      const consequence = [r.newParallelSeconds ? `${formatDuration(r.newParallelSeconds)} of simultaneous watering across fourteen nights; the old plan could not be compared.` : '', r.additionalOverlapSeconds ? `${formatDuration(r.additionalOverlapSeconds)} more simultaneous watering across ${r.affectedNights} nights.` : '', r.laterFinishNights ? `Finishes later on ${r.laterFinishNights} nights; latest ${clockAt(r.latestFinish)}.` : '', r.afterPreferredNights ? `${r.afterPreferredNights} nights finish after the preferred target.` : ''].filter(Boolean).join(' ');
      return `<div class="fit-scenario"><b>${escape(r.label + seasonal)}</b><p>${r.status === 'needs-adjustment' ? escape(r.message) : consequence ? `Fits. ${consequence}` : `Fits ${r.maxConcurrent === 2 ? 'with up to two zones at once' : 'with one zone at a time'}.`}${r.sunriseKnown === false ? ' Sunrise is estimated from the fallback time.' : ''}</p><details><summary>Why?</summary><p>${escape(r.detail)}</p></details></div>`;
    }).join(''));
    html('plan-fit-alternatives', (editReview?.alternatives ?? []).map(a => `<article><p>${escape(a.description)}</p><p>${a.assessment.scenarios.map(r => `${escape(r.label)}: fits${r.additionalOverlapSeconds ? `; ${formatDuration(r.additionalOverlapSeconds)} more overlap` : r.newParallelSeconds ? `; ${formatDuration(r.newParallelSeconds)} total overlap` : ''}${r.afterPreferredNights ? `; ${r.afterPreferredNights} nights past the preferred finish` : ''}${r.laterFinishNights ? `; latest finish ${clockAt(r.latestFinish)}` : ''}`).join(' · ')}</p><button class="outline" data-fit-alternative="${a.id}"${editBusy ? ' disabled' : ''}>Use this adjustment and save</button></article>`).join('') + (report?.status === 'needs-adjustment' && !editReview.alternatives.length ? '<p>No verified adjustment found in this search. Edit the draft or keep it as an unfinished plan; this does not prove your goal is impossible.</p>' : ''));
    $('fit-check').hidden = !draft && !editError;
    $('fit-save').hidden = !draft || !report || report.status === 'needs-adjustment';
    $('fit-unfinished').hidden = !draft || report?.status !== 'needs-adjustment';
    $('fit-discard').hidden = !draft;
    for (const id of ['fit-check', 'fit-save', 'fit-unfinished', 'fit-discard']) $(id).disabled = editBusy;
    const selectedIds = pendingEdit.seasonalZoneIds ?? editReview?.plan.seasonalZoneIds ?? getState().plan.seasonalZoneIds ?? [];
    html('fit-seasonal-zones', zones().map(z => `<label><input type="checkbox" data-fit-seasonal="${z.id}"${selectedIds.includes(z.id) ? ' checked' : ''}${editBusy ? ' disabled' : ''}>${escape(z.name)}</label>`).join(''));
  }
  $('fit-check').addEventListener('click', () => checkDraft(false));
  $('fit-save').addEventListener('click', () => applyReviewed());
  $('fit-unfinished').addEventListener('click', () => applyReviewed(null, true));
  $('fit-discard').addEventListener('click', () => { pendingEdit = {}; rememberDraft(); drafts.clear(); typed.clear(); settingsDraft = null; editReview = null; editError = ''; seasonalEdited = false; checkDraft(false); });
  $('plan-fit').addEventListener('click', e => { const button = e.target.closest('[data-fit-alternative]'); if (button && !editBusy) applyReviewed(button.dataset.fitAlternative); });
  $('plan-fit').addEventListener('change', e => {
    if (!e.target.matches('[data-fit-seasonal]') || editBusy) return;
    pendingEdit.seasonalZoneIds = [...$('fit-seasonal-zones').querySelectorAll('input:checked')].map(i => i.dataset.fitSeasonal);
    rememberDraft(); editReview = null; checkDraft(true);
  });

  function build(list) {
    $('plan-rows').innerHTML = list.map(z => `<div class="prow" role="row" data-row="${z.id}">
      <div class="pzone" role="rowheader"><label class="zone-enabled"><input type="checkbox" data-enabled="${z.id}" aria-label="Enable ${escape(z.name)} in the watering plan"></label><span class="zone-num num">${String(z.id).padStart(2, '0')}</span><span class="pz-text"><b title="${escape(z.name)}">${escape(z.name)}</b><small data-meta></small></span></div>
      <label class="pdur" role="cell"><input class="num" data-dur="${z.id}" inputmode="decimal" autocomplete="off" placeholder="—" aria-label="100% run length for ${escape(z.name)}, in minutes"><span>min</span></label>
      <div class="pseasonal" role="cell"><label class="pdur"><input class="num" data-seasonal="${z.id}" type="number" min="50" max="200" step="1" required inputmode="numeric" aria-label="Seasonal percentage for ${escape(z.name)}"><span>%</span></label></div>
      <div class="pcad" role="cell"><select data-cad="${z.id}" aria-label="How often ${escape(z.name)} waters"></select></div>
      <div class="prain" role="cell"><label class="rain-choice" title="Water during rain delays"><input type="checkbox" data-rain="${z.id}" aria-label="Water ${escape(z.name)} during rain delays"></label></div>
      <div class="pcells" data-cells></div>
      <span class="pnext num" role="cell" data-next></span>
    </div>`).join('');
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
    renderFit();
    const fitKey = JSON.stringify([state.plan, state.location, dateKey(currentNight())]);
    if (!editBusy && !hasDraft() && fitKey !== observedFitKey) { observedFitKey = fitKey; queueMicrotask(() => checkDraft(false)); }
    const list = zones(), cfg = settings(), all = intents();
    const percentages = new Set(list.map(z => all[z.id]?.seasonalPercent ?? 100));
    const commonPercent = percentages.size === 1 ? [...percentages][0] : null;
    $('seasonal-status').textContent = editBusy && Object.hasOwn(pendingEdit, 'seasonalPercent') ? 'Checking all zones…' : !list.length ? 'Load zones to get started.' : commonPercent == null ? 'Mixed' : `All zones ${commonPercent}%`;
    if (!seasonalEdited && document.activeElement !== $('seasonal-all')) $('seasonal-all').value = commonPercent ?? '';
    $('seasonal-all').placeholder = 'Mixed';
    $('seasonal-all').disabled = editBusy || !list.length;
    $('seasonal-apply').disabled = editBusy || !list.length;
    const key = list.map(z => `${z.id}:${z.name}`).join('|');
    if (key !== rowsKey) { rowsKey = key; build(list); }
    const start = currentNight();
    const loc = state.location;
    const sunriseAt = loc ? date => sunrise(date, loc.latitude, loc.longitude) : () => null;
    const plan = resolvePlan({ zones: list, intents: all, settings: cfg, start, rain: rainNights(start, cfg), sunriseAt });
    selected = Math.min(selected, NIGHTS - 1);
    const names = Object.fromEntries(list.map(z => [z.id, z.name]));
    const label = d => d === 0 ? 'Tonight' : d === 1 ? 'Tomorrow' : `${WD[addDays(start, d).getDay()]} ${addDays(start, d).getDate()}`;

    // Summary and night settings
    const planned = plan.zones.filter(z => !z.problem).length, todo = plan.zones.filter(z => NEEDS.has(z.problem)).length;
    const open = plan.nights.map((n, d) => ({ n, d })).filter(({ n }) => n.start != null);
    const busiest = open.reduce((a, b) => (!a || b.n.seconds > a.n.seconds ? b : a), null);
    const latest = open.reduce((a, b) => (!a || b.n.finish > a.n.finish ? b : a), null);
    $('plan-summary').textContent = !planned && !todo ? 'No zones yet.' : [
      `${planned} of ${list.length} zones planned`,
      busiest && `busiest night ${busiest.d < 2 ? label(busiest.d).toLowerCase() : label(busiest.d)} with ${formatDuration(busiest.n.seconds)} of water`,
      latest && `latest finish ${clockAt(latest.n.finish)}`,
    ].filter(Boolean).join(' · ');
    for (const [id, k] of [['plan-earliest', 'earliestStart'], ['plan-finish', 'finishBeforeSunrise'], ['plan-hard', 'hardDeadline']]) {
      const select = $(id), value = String(cfg[k]);
      if (![...select.options].some(o => o.value === value)) select.add(new Option(k === 'finishBeforeSunrise' ? `${cfg[k]} min before sunrise` : clockAt(cfg[k]), value));
      if (document.activeElement !== select) select.value = value;
    }
    document.querySelectorAll('[data-lanes]').forEach(b => { b.setAttribute('aria-checked', String(Number(b.dataset.lanes) === cfg.lanes)); b.disabled = editBusy; });
    for (const id of ['plan-earliest', 'plan-finish', 'plan-hard', 'plan-rebalance', 'review-rebalance', 'plan-programs']) $(id).disabled = editBusy || hasDraft();
    for (const id of ['plan-earliest', 'plan-finish', 'plan-hard']) $(id).disabled = editBusy;
    $('plan-all').setAttribute('aria-pressed', String(!needsOnly));
    $('plan-needs').setAttribute('aria-pressed', String(needsOnly));
    $('plan-needs').parentElement.hidden = todo === 0;
    if (todo === 0) needsOnly = false;
    $('plan-needs-count').textContent = todo;
    $('plan-needs-count').classList.toggle('hot', todo > 0);

    renderNight(plan.nights[selected], selected, start, names, cfg);

    // Night columns
    const head = plan.nights.map((n, d) => {
      const date = addDays(start, d);
      const top = n.rain ? 'Rain' : d === 0 ? 'Tonight' : date.getDate() === 1 || d === 1 ? MONTH[date.getMonth()] : '';
      return `<button class="ph${d === selected ? ' sel' : ''}${n.rain ? ' rain' : ''}" data-night="${d}" aria-pressed="${d === selected}" aria-label="Show the night of ${WEEKDAY[date.getDay()]} ${MONTH[date.getMonth()]} ${date.getDate()}"><small>${top}</small><span>${WD[date.getDay()]}</span><b class="num">${date.getDate()}</b></button>`;
    }).join('');
    html('plan-head-nights', head);
    const span = cfg.hardDeadline + 1440 - cfg.earliestStart;
    html('plan-foot-nights', plan.nights.map((n, d) => {
      const text = n.status === 'rain' ? 'Rain' : n.start == null && !n.deferred.length ? '—' : n.status === 'over' ? `+${n.deferred.length}` : clockAt(n.finish).replace(/am|pm/, '');
      const fill = n.start == null ? 0 : Math.min(100, Math.round((n.finish - n.start) / span * 100));
      return `<button class="pf ${n.status}${d === selected ? ' sel' : ''}${n.rain ? ' rain' : ''}" data-night="${d}" aria-label="${label(d)}: ${n.status === 'rain' ? 'rain hold' : n.start == null ? 'nothing due' : `done ${clockAt(n.finish)}`}"><b class="num">${text}</b><span class="bar"><i data-width="${fill}"></i></span></button>`;
    }).join(''));
    place($('plan-foot-nights'));

    // Zone rows
    const byId = Object.fromEntries(plan.zones.map(z => [z.id, z]));
    let shown = 0;
    for (const z of list) {
      const row = document.querySelector(`[data-row="${z.id}"]`), p = byId[z.id], intent = all[z.id] ?? blank();
      const hidden = needsOnly && !NEEDS.has(p.problem);
      row.hidden = hidden; if (!hidden) shown++;
      zoneEnabled(row, intent.enabled === false);
      row.classList.toggle('todo', NEEDS.has(p.problem));
      const input = row.querySelector('[data-dur]'), select = row.querySelector('[data-cad]');
      if (document.activeElement !== input) input.value = typed.get(z.id) ?? (intent.seconds == null ? '' : String(Number((intent.seconds / 60).toFixed(4))));
      input.closest('label').classList.toggle('invalid', typed.has(z.id));
      input.closest('label').classList.toggle('empty', !intent.seconds && !typed.has(z.id));
      const seasonal = row.querySelector('[data-seasonal]'), seconds = adjustedSeconds(intent);
      if (document.activeElement !== seasonal) seasonal.value = intent.seasonalPercent ?? 100;
      row.querySelectorAll('input, select').forEach(el => { el.disabled = editBusy; });
      const cad = cadenceKey(intent.cadence);
      const common = [{ every: 2 }, { perWeek: 3 }, { perWeek: 2 }, { every: 7 }];
      const choices = expandedCadences.has(z.id) ? CADENCES : common;
      const offered = [...choices];
      if (intent.cadence && !offered.some(c => cadenceKey(c) === cadenceKey(intent.cadence))) offered.push(intent.cadence);
      const options = offered.map(c => `<option value="${cadenceKey(c)}">${cadenceLabel(c)}</option>`).join('')
        + (expandedCadences.has(z.id) ? '' : '<option value="other">Other…</option>')
        + '<option value="">Not set</option>';
      if (select._options !== options) { select.innerHTML = options; select._options = options; }
      select.value = cad;
      row.querySelector('[data-enabled]').checked = intent.enabled !== false;
      row.querySelector('[data-enabled]').parentElement.title = intent.enabled === false ? 'Enable zone' : 'Disable zone';
      row.querySelector('[data-rain]').checked = intent.waterDuringRain === true;
      select.classList.toggle('empty', !intent.cadence);
      const meta = typed.has(z.id) ? ['Enter 1–240 minutes', 'bad']
        : p.problem === 'unset' ? ['Needs a run length and how often', 'warn']
        : p.problem === 'duration' ? ['Add a run length', 'warn']
        : p.problem === 'cadence' ? ['Choose how often', 'warn']
        : p.problem === 'paused' ? ['Disabled · settings kept', '']
        : [`≈ ${formatDuration(Math.round(p.weeklySeconds / 60) * 60)} a week`, ''];
      const metaEl = row.querySelector('[data-meta]');
      metaEl.textContent = meta[0]; metaEl.className = meta[1];
      const cells = p.cells.map((c, d) => {
        const date = addDays(start, d), when = `${WEEKDAY[date.getDay()]} ${MONTH[date.getMonth()]} ${date.getDate()}`;
        const cls = `pc${d === selected ? ' sel' : ''}${plan.nights[d].rain ? ' rain' : ''}`;
        if (c.kind === 'water') return `<button class="${cls}" data-night="${d}" aria-label="${escape(z.name)} waters ${formatDuration(seconds)} ${when}${c.late ? `, ${c.late} night${c.late > 1 ? 's' : ''} late` : ''}"><span class="pill-run${c.late ? ' late' : ''} num">${short(seconds)}</span></button>`;
        if (c.kind === 'held') return `<button class="${cls}" data-night="${d}" aria-label="${escape(z.name)} is due ${when} and waits out the rain"><span class="pill-held">${RAIN_ICON}</span></button>`;
        if (c.kind === 'deferred') return `<button class="${cls}" data-night="${d}" aria-label="${escape(z.name)} is due ${when} but doesn’t fit"><span class="pill-over">!</span></button>`;
        return `<button class="${cls}" data-night="${d}" aria-label="Show ${escape(z.name)} on ${when}"${p.problem ? ' disabled' : ''}><i></i></button>`;
      }).join('');
      const cellsEl = row.querySelector('[data-cells]');
      if (cellsEl._html !== cells) { cellsEl.innerHTML = cells; cellsEl._html = cells; }
      const next = row.querySelector('[data-next]');
      next.textContent = p.problem ? '—' : p.next < 0 ? 'Later' : p.next === 0 ? 'Tonight' : p.next === 1 ? 'Tmrw' : label(p.next);
      next.classList.toggle('soon', p.next === 0 && !p.problem);
    }
    $('plan-empty').hidden = shown > 0;
    $('plan-empty').textContent = needsOnly ? 'Every zone has a plan.' : 'No named zones yet. Check the controller connection.';
  }

  function renderNight(n, d, start, names, cfg) {
    const date = addDays(start, d), morning = addDays(start, d + 1);
    const lo = Math.min(n.earliestStart, 21 * 60 + 30) - 30, hi = Math.max(n.hardDeadline, n.sunrise) + 30, span = hi - lo;
    const pos = m => Math.max(0, Math.min(100, (m - lo) / span * 100)).toFixed(3);
    const [status, tone] = STATUS[n.status](n);
    const ticks = [];
    for (let m = Math.ceil(lo / 120) * 120; m <= hi; m += 120) ticks.push(`<span data-left="${pos(m)}">${clockAt(m)}</span>`);
    const laneNames = n.lanes[1]?.length ? ['Lane 1', 'Lane 2'] : ['Zones'];
    const lanes = laneNames.map((name, i) => `<div class="lane"><span class="lane-name">${name}</span><div class="track">${(n.lanes[i] ?? []).map(r => {
      const width = (r.to - r.from) / span * 100;
      const title = `${names[r.zone]} · ${formatDuration(r.seconds)} · ${clockAt(r.from)}–${clockAt(r.to)}${r.late ? ` · ${r.late} night${r.late > 1 ? 's' : ''} late` : ''}`;
      return `<div class="run${r.late ? ' late' : ''}" title="${escape(title)}" data-left="${pos(r.from)}" data-width="${width.toFixed(3)}">${width > 4.5 ? `<b>${escape(names[r.zone])}</b><small class="num">${formatDuration(r.seconds)}</small>` : ''}</div>`;
    }).join('')}</div></div>`).join('');
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
    const tried = whatIf.has(n.date);
    const held = n.rain && !tried;
    html('night-card', `
      <div class="night-side">
        <div><p class="muted">${WD[date.getDay()]} ${MONTH[date.getMonth()]} ${date.getDate()} → ${WD[morning.getDay()]} morning</p><h2>${d === 0 ? 'Tonight' : d === 1 ? 'Tomorrow night' : `${WEEKDAY[date.getDay()]} night`}</h2></div>
        <span class="pill ${tone}"><i class="dot"></i>${status}</span>
        <dl class="night-stats num">
          <div><dt>Starts</dt><dd>${n.start == null ? '—' : clockAt(n.start)}</dd></div>
          <div><dt>Done</dt><dd>${n.finish == null ? '—' : clockAt(n.finish)}</dd></div>
          <div><dt>Water time</dt><dd title="${formatDuration(n.seconds)}">${n.seconds ? short(n.seconds) : '—'}</dd></div>
          <div><dt>Zones</dt><dd>${n.lanes.flat().length || '—'}</dd></div>
        </dl>
        ${held ? '<p class="hint">The controller’s rain delay covers this night.</p>' : `<button class="chip try-rain" data-whatif="${n.date}" aria-pressed="${tried}">${RAIN_ICON}${tried ? 'Rain hold on · tap to clear' : 'What if it rains?'}</button>`}
      </div>
      <div class="night-main">
        <div class="axis num">${ticks.join('')}<span class="sun" data-left="${pos(n.sunrise)}"><svg aria-hidden="true"><use href="#i-sun"/></svg>Sunrise ${clockAt(n.sunrise)}</span></div>
        <div class="lanes">
          <div class="overlay" aria-hidden="true"><i class="zone-before" data-width="${pos(n.earliestStart)}"></i><i class="zone-day" data-left="${pos(n.sunrise)}"></i><i class="zone-after" data-left="${pos(n.hardDeadline)}"></i></div>
          ${lanes}
          <div class="overlay" aria-hidden="true"><i class="mark aim" data-left="${pos(n.preferredFinish)}"></i><i class="mark hard" data-left="${pos(n.hardDeadline)}"></i></div>
          ${n.start == null ? `<p class="lanes-empty">${n.rain ? 'Rain hold · nothing waters this night' : n.deferred.length ? 'Nothing fits this night' : 'Nothing is due this night'}</p>` : ''}
        </div>
        <div class="legend num">
          <span><i class="k-before"></i>Before ${clockAt(n.earliestStart)}</span>
          <span><i class="k-aim"></i>Aim to finish ${clockAt(n.preferredFinish)}</span>
          <span><i class="k-hard"></i>Never past ${clockAt(n.hardDeadline)}</span>
          <span><i class="k-run"></i>On schedule</span>
          <span><i class="k-late"></i>Catching up</span>
        </div>
        ${notes.length ? `<ul class="night-notes">${notes.map(([tone, text]) => `<li class="${tone}">${escape(text)}</li>`).join('')}</ul>` : ''}
      </div>`);
    place($('night-card'));
  }

  async function reviewRebalance() {
    if (reviewing) return;
    reviewing = true;
    try {
      rebalanceProposal = await api('/plan/rebalance-preview', {});
      const p = rebalanceProposal, names = Object.fromEntries(zones().map(z => [z.id, z.name]));
      const pretty = key => { const [y, m, d] = key.split('-').map(Number); return `${MONTH[m - 1]} ${d}, ${y}`; };
      $('rebalance-summary').textContent = p.changes.length
        ? `Move ${p.changes.length} zone${p.changes.length === 1 ? '' : 's'}. Over the next 12 weeks, the busiest regular night drops from ${formatDuration(p.beforePeakSeconds)} to ${formatDuration(p.afterPeakSeconds)} of total zone watering.`
        : 'No useful rebalance found. Existing watering dates can stay as they are.';
      $('rebalance-changes').innerHTML = p.changes.map(c => `<li><b>${escape(names[c.zone] ?? `Zone ${c.zone}`)}</b><span>${pretty(c.before)} → ${pretty(c.after)}</span><span>${Math.abs(c.days)} day${Math.abs(c.days) === 1 ? '' : 's'} ${c.days > 0 ? 'later — a longer wait this time' : 'earlier — a shorter gap this time'}. Then the usual frequency continues.</span></li>`).join('');
      $('rebalance-error').textContent = '';
      $('confirm-rebalance').hidden = !p.changes.length;
      $('confirm-rebalance').disabled = false;
      $('rebalance-dialog').showModal();
    } catch (e) { message(`Couldn’t prepare the rebalance: ${e.message}`, true); }
    finally { reviewing = false; }
  }
  function programReport(p, title) {
    const stats = p.summary;
    const summary = `${stats.zones} zones · ${stats.programs}/10 programs · ${formatDuration(stats.weeklySeconds)} per week`;
    if (p.status !== 'candidate') return `<section><h3>${escape(title)}</h3><p>${summary}</p><p>No complete candidate.</p><ul>${p.issues.map(i => `<li>${escape(i.message)}</li>`).join('')}</ul></section>`;
    return `<section><h3>${escape(title)}</h3><p>${summary}</p>
      <p>${stats.maxConcurrent <= 1 ? 'One zone at a time.' : `Up to ${stats.maxConcurrent} zones at once; ${formatDuration(stats.parallelSeconds)} of overlap across 14 nights.`} ${stats.minimumOverlapProven ? 'Minimum overlap for this window.' : 'Feasible candidate; overlap may be reducible.'}</p>
      <p>${p.horizon.sunriseKnown ? '' : 'Sunrise location is unknown; using the fallback. '}${stats.preferredWindowMet ? 'Fits before' : 'Uses time after'} the shared finish target of ${clockAt(p.horizon.preferredFinish)}. Dates: ${p.dates[0]} to ${p.dates.at(-1)}.</p>
      <details><summary>Programs, steps &amp; watering dates</summary><div class="program-table"><table><thead><tr><th>Program</th><th>Starts</th><th>Runtime</th><th>Zones in order</th><th>Evening dates</th></tr></thead><tbody>${p.programs.map(g => `<tr><td>${g.slot}${g.waterDuringRain ? ' · covered' : ''}</td><td>${clockAt(g.startMinute)}${g.startDayOffset ? ' (+1 day)' : ''}</td><td>${formatDuration(g.seconds)}</td><td>${g.steps.map(s => `${escape(s.name)} (${formatDuration(s.seconds)})`).join(' → ')}</td><td>${g.eveningMask.map((on, d) => on ? p.dates[d].slice(5) : null).filter(Boolean).join(', ')}</td></tr>`).join('')}</tbody></table></div></details>
      <details><summary>Night-by-night totals</summary><ul>${p.nights.map(n => `<li>${n.date}: ${formatDuration(n.seconds)}${n.start == null ? '' : `, ${clockAt(n.start)}–${clockAt(n.finish)}`}; ${n.parallelSeconds ? `${formatDuration(n.parallelSeconds)} overlap` : 'no overlap'}</li>`).join('')}</ul></details>
      <details><summary>Controller assumptions still to verify</summary><ul>${p.assumptions.map(a => `<li>${escape(a)}</li>`).join('')}</ul></details></section>`;
  }
  async function previewPrograms(compare = false) {
    $('program-error').textContent = 'Compiling saved intentions…';
    $('compare-programs').disabled = true;
    $('program-results').innerHTML = '';
    try {
      const base = await api('/plan/program-preview', {});
      let reports = programReport(base, 'Saved plan');
      if (compare) {
        const enabledOverrides = Object.fromEntries([...$('program-overrides').querySelectorAll('input:checked')].map(i => [i.value, true]));
        if (Object.keys(enabledOverrides).length) reports += programReport(await api('/plan/program-preview', { enabledOverrides }), 'Selected paused zones enabled');
      }
      $('program-results').innerHTML = reports;
      $('program-error').textContent = 'Snapshot only. Reopen this preview after changing intentions or night settings.';
    } catch (e) { $('program-error').textContent = `Couldn’t compile: ${e.message}`; }
    finally { $('compare-programs').disabled = false; }
  }
  $('plan-programs').addEventListener('click', () => {
    const paused = zones().filter(z => intents()[z.id]?.enabled === false);
    $('program-overrides').innerHTML = `<legend>Seasonal comparison — enable paused zones for this preview</legend>${paused.length ? paused.map(z => `<label><input type="checkbox" value="${escape(z.id)}" checked> ${escape(z.name)}</label>`).join('') : '<p>No paused zones.</p>'}`;
    $('compare-programs').hidden = !paused.length;
    $('program-dialog').showModal(); previewPrograms(Boolean(paused.length));
  });
  $('compare-programs').addEventListener('click', () => previewPrograms(true));
  $('close-programs').addEventListener('click', () => $('program-dialog').close());

  $('plan-rebalance').addEventListener('click', reviewRebalance);
  $('review-rebalance').addEventListener('click', reviewRebalance);
  $('dismiss-rebalance').addEventListener('click', () => { $('rebalance-prompt').hidden = true; });
  $('cancel-rebalance').addEventListener('click', () => $('rebalance-dialog').close());
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

  const view = $('plan-view');
  view.addEventListener('click', e => {
    const night = e.target.closest('[data-night]'), rain = e.target.closest('[data-whatif]'), lanes = e.target.closest('[data-lanes]');
    if (night) { selected = Number(night.dataset.night); render(); }
    else if (rain) { whatIf.has(rain.dataset.whatif) ? whatIf.delete(rain.dataset.whatif) : whatIf.add(rain.dataset.whatif); render(); }
    else if (lanes) saveSettings({ lanes: Number(lanes.dataset.lanes) });
    else if (e.target.closest('#plan-all')) { needsOnly = false; render(); }
    else if (e.target.closest('#plan-needs')) { needsOnly = true; render(); }
  });
  // Typing keeps a draft; leaving the field checks feasibility before saving.
  view.addEventListener('input', e => {
    const seasonal = e.target.closest('[data-seasonal]');
    if (seasonal && !editBusy) {
      const value = Number(seasonal.value);
      if (Number.isInteger(value) && value >= 50 && value <= 200) { stageIntent(seasonal.dataset.seasonal, { seasonalPercent: value }); render(); }
      return;
    }
    const input = e.target.closest('[data-dur]');
    if (!input) return;
    const id = input.dataset.dur, seconds = parseDuration(input.value);
    if (Number.isNaN(seconds) || seconds > 4 * 3600 || seconds === 0) { typed.set(id, input.value); editReview = null; render(); return; }
    typed.delete(id);
    if (editBusy) return;
    stageIntent(id, { seconds });
    render();
  });
  view.addEventListener('change', e => {
    const input = e.target.closest('[data-dur]'), select = e.target.closest('[data-cad]'), rain = e.target.closest('[data-rain]'), enabled = e.target.closest('[data-enabled]'), seasonal = e.target.closest('[data-seasonal]');
    if (seasonal) {
      if (!seasonal.reportValidity()) return;
      saveIntent(seasonal.dataset.seasonal, { seasonalPercent: Number(seasonal.value) });
    } else if (input) {
      const id = input.dataset.dur, seconds = parseDuration(input.value);
      if (Number.isNaN(seconds) || seconds > 4 * 3600 || seconds === 0) { typed.set(id, input.value); render(); return; }
      typed.delete(id);
      saveIntent(id, { seconds });
    } else if (select) {
      const id = select.dataset.cad;
      if (select.value === 'other') { expandedCadences.add(id); render(); return; }
      saveIntent(id, { cadence: cadenceFromKey(select.value) });
    } else if (enabled) saveIntent(enabled.dataset.enabled, { enabled: enabled.checked });
    else if (rain) saveIntent(rain.dataset.rain, { waterDuringRain: rain.checked });
    else if (e.target.id === 'plan-earliest') saveSettings({ earliestStart: Number(e.target.value) });
    else if (e.target.id === 'plan-finish') saveSettings({ finishBeforeSunrise: Number(e.target.value) });
    else if (e.target.id === 'plan-hard') saveSettings({ hardDeadline: Number(e.target.value) });
  });
  // Enter moves to the next zone's run length, like a spreadsheet.
  view.addEventListener('keydown', e => {
    const input = e.target.closest('[data-dur]');
    if (!input || e.key !== 'Enter') return;
    e.preventDefault();
    const inputs = [...view.querySelectorAll('.prow:not([hidden]) [data-dur]')];
    // Moving focus checks this draft before deciding whether it can save.
    const next = inputs[inputs.indexOf(input) + (e.shiftKey ? -1 : 1)];
    if (next) next.focus(); else input.blur();
  });

  return { render };
}
