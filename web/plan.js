// The Plan tab: what each zone needs, and the nights that follow from it.
// Advisory only. Edits save to the bridge's local store and never reach Tucor.
import { CADENCES, NIGHTS, FALLBACK_SUNRISE, addDays, cadenceFromKey, cadenceKey, cadenceLabel, currentNight, dateKey, durationText, formatDuration, parseDuration, resolvePlan, sunrise } from './planner.js';

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
const short = seconds => seconds < 60 ? `${seconds}s` : seconds < 3600 ? String(Math.round(seconds / 60)) : `${Math.floor(seconds / 3600)}h${Math.round(seconds % 3600 / 60) ? String(Math.round(seconds % 3600 / 60)).padStart(2, '0') : ''}`;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function createPlan({ $, api, escape, message, html, getState }) {
  const drafts = new Map();          // zone id → intent shown before the server confirms it
  const typed = new Map();           // zone id → unreadable duration text, kept so it can be fixed
  let settingsDraft = null, selected = 0, needsOnly = false, whatIf = new Set(), rowsKey = '', last = null;

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
  const blank = () => ({ seconds: null, cadence: null, enabled: true, firstDue: null });

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

  async function saveIntent(id, patch) {
    const next = { ...blank(), ...intents()[id], ...patch };
    drafts.set(id, next);
    render();
    try { await api(`/zones/${id}/intent`, patch); }
    catch (e) { drafts.delete(id); message(`Couldn’t save the plan for zone ${id}: ${e.message}`, true); render(); }
  }
  async function saveSettings(patch) {
    settingsDraft = { ...settings(), ...patch };
    render();
    try { await api('/plan', patch); }
    catch (e) { settingsDraft = null; message(`Couldn’t save the night settings: ${e.message}`, true); render(); }
  }

  function build(list) {
    const options = [...CADENCES.map(c => `<option value="${cadenceKey(c)}">${cadenceLabel(c)}</option>`), '<option value="off">Paused</option>', '<option value="">Not set</option>'].join('');
    $('plan-rows').innerHTML = list.map(z => `<div class="prow" role="row" data-row="${z.id}">
      <div class="pzone" role="rowheader"><span class="zone-num num">${String(z.id).padStart(2, '0')}</span><span class="pz-text"><b>${escape(z.name)}</b><small data-meta></small></span></div>
      <label class="pdur" role="cell"><input class="num" data-dur="${z.id}" inputmode="decimal" autocomplete="off" placeholder="—" aria-label="Run length for ${escape(z.name)}, in minutes"><span>min</span></label>
      <div class="pcad" role="cell"><select data-cad="${z.id}" aria-label="How often ${escape(z.name)} waters">${options}</select></div>
      <div class="pcells" data-cells></div>
      <span class="pnext num" role="cell" data-next></span>
    </div>`).join('');
  }

  function render() {
    const state = getState();
    if (!state?.plan) return;
    const list = zones(), cfg = settings(), all = intents();
    const key = list.map(z => `${z.id}:${z.name}`).join('|');
    if (key !== rowsKey) { rowsKey = key; build(list); }
    const start = currentNight();
    const loc = state.location;
    const sunriseAt = loc ? date => sunrise(date, loc.latitude, loc.longitude) : () => null;
    const plan = resolvePlan({ zones: list, intents: all, settings: cfg, start, rain: rainNights(start, cfg), sunriseAt });
    last = { plan, start, list };
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
    for (const [id, k] of [['plan-earliest', 'earliestStart'], ['plan-finish', 'finishBeforeSunrise'], ['plan-hard', 'hardDeadline']]) if (document.activeElement !== $(id)) $(id).value = String(cfg[k]);
    document.querySelectorAll('[data-lanes]').forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.lanes) === cfg.lanes)));
    $('plan-all').setAttribute('aria-pressed', String(!needsOnly));
    $('plan-needs').setAttribute('aria-pressed', String(needsOnly));
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
      row.classList.toggle('paused', p.problem === 'paused');
      row.classList.toggle('todo', NEEDS.has(p.problem));
      const input = row.querySelector('[data-dur]'), select = row.querySelector('[data-cad]');
      if (document.activeElement !== input) input.value = typed.get(z.id) ?? durationText(intent.seconds);
      input.closest('label').classList.toggle('invalid', typed.has(z.id));
      input.closest('label').classList.toggle('empty', !intent.seconds && !typed.has(z.id));
      const cad = intent.enabled === false && intent.cadence ? 'off' : cadenceKey(intent.cadence);
      if (document.activeElement !== select) select.value = cad;
      select.classList.toggle('empty', !intent.cadence);
      const meta = typed.has(z.id) ? ['Try 25, 7:30, 0:20 or 2h', 'bad']
        : p.problem === 'unset' ? ['Needs a run length and how often', 'warn']
        : p.problem === 'duration' ? ['Add a run length', 'warn']
        : p.problem === 'cadence' ? ['Choose how often', 'warn']
        : p.problem === 'paused' ? ['Paused · not watering', '']
        : [`≈ ${formatDuration(Math.max(60, Math.round(p.weeklySeconds / 60) * 60))} a week`, ''];
      const metaEl = row.querySelector('[data-meta]');
      metaEl.textContent = meta[0]; metaEl.className = meta[1];
      const cells = p.cells.map((c, d) => {
        const date = addDays(start, d), when = `${WEEKDAY[date.getDay()]} ${MONTH[date.getMonth()]} ${date.getDate()}`;
        const cls = `pc${d === selected ? ' sel' : ''}${plan.nights[d].rain ? ' rain' : ''}`;
        if (c.kind === 'water') return `<button class="${cls}" data-move="${z.id}" data-day="${d}" aria-label="${escape(z.name)} waters ${formatDuration(intent.seconds)} ${when}${c.late ? `, ${c.late} night${c.late > 1 ? 's' : ''} late` : ''}"><span class="pill-run${c.late ? ' late' : ''} num">${short(intent.seconds)}</span></button>`;
        if (c.kind === 'held') return `<button class="${cls}" data-move="${z.id}" data-day="${d}" aria-label="${escape(z.name)} is due ${when} and waits out the rain"><span class="pill-held">${RAIN_ICON}</span></button>`;
        if (c.kind === 'deferred') return `<button class="${cls}" data-move="${z.id}" data-day="${d}" aria-label="${escape(z.name)} is due ${when} but doesn’t fit"><span class="pill-over">!</span></button>`;
        return `<button class="${cls}" data-move="${z.id}" data-day="${d}" aria-label="Move ${escape(z.name)}’s next watering to ${when}"${p.problem ? ' disabled' : ''}><i></i></button>`;
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
    const laneNames = cfg.lanes === 2 ? ['Lane 1', 'Lane 2'] : ['Zones'];
    const lanes = laneNames.map((name, i) => `<div class="lane"><span class="lane-name">${name}</span><div class="track">${(n.lanes[i] ?? []).map(r => {
      const width = (r.to - r.from) / span * 100;
      const title = `${names[r.zone]} · ${formatDuration(r.seconds)} · ${clockAt(r.from)}–${clockAt(r.to)}${r.late ? ` · ${r.late} night${r.late > 1 ? 's' : ''} late` : ''}`;
      return `<div class="run${r.late ? ' late' : ''}" title="${escape(title)}" data-left="${pos(r.from)}" data-width="${width.toFixed(3)}">${width > 4.5 ? `<b>${escape(names[r.zone])}</b><small class="num">${formatDuration(r.seconds)}</small>` : ''}</div>`;
    }).join('')}</div></div>`).join('');
    const notes = n.rain
      ? (n.held.length ? [['rain', `${n.held.map(id => names[id]).join(', ')} ${n.held.length > 1 ? 'wait' : 'waits'} for the next clear night.`]] : [])
      : [
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
          <div><dt>Water time</dt><dd>${n.seconds ? formatDuration(n.seconds) : '—'}</dd></div>
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

  // The page's CSP forbids inline style attributes; position through the DOM.
  function place(root) {
    root.querySelectorAll('[data-left]').forEach(el => { el.style.left = `${el.dataset.left}%`; });
    root.querySelectorAll('[data-width]').forEach(el => { el.style.width = `${el.dataset.width}%`; });
  }

  const view = $('plan-view');
  view.addEventListener('click', e => {
    const night = e.target.closest('[data-night]'), move = e.target.closest('[data-move]'), rain = e.target.closest('[data-whatif]'), lanes = e.target.closest('[data-lanes]');
    if (night) { selected = Number(night.dataset.night); render(); }
    else if (move && last) {
      const id = move.dataset.move, intent = intents()[id];
      if (!intent?.cadence || !intent.seconds) return;
      saveIntent(id, { firstDue: dateKey(addDays(last.start, Number(move.dataset.day))), enabled: true });
    } else if (rain) { whatIf.has(rain.dataset.whatif) ? whatIf.delete(rain.dataset.whatif) : whatIf.add(rain.dataset.whatif); render(); }
    else if (lanes) saveSettings({ lanes: Number(lanes.dataset.lanes) });
    else if (e.target.closest('#plan-all')) { needsOnly = false; render(); }
    else if (e.target.closest('#plan-needs')) { needsOnly = true; render(); }
  });
  // Typing previews immediately; leaving the field saves.
  view.addEventListener('input', e => {
    const input = e.target.closest('[data-dur]');
    if (!input) return;
    const id = input.dataset.dur, seconds = parseDuration(input.value);
    if (Number.isNaN(seconds) || seconds > 4 * 3600 || seconds === 0) return;
    typed.delete(id);
    drafts.set(id, { ...blank(), ...intents()[id], seconds });
    render();
  });
  view.addEventListener('change', e => {
    const input = e.target.closest('[data-dur]'), select = e.target.closest('[data-cad]');
    if (input) {
      const id = input.dataset.dur, seconds = parseDuration(input.value);
      if (Number.isNaN(seconds) || seconds > 4 * 3600 || seconds === 0) { typed.set(id, input.value); render(); return; }
      typed.delete(id);
      saveIntent(id, { seconds });
    } else if (select) {
      const id = select.dataset.cad;
      saveIntent(id, select.value === 'off' ? { enabled: false } : { cadence: cadenceFromKey(select.value), enabled: true });
    } else if (e.target.id === 'plan-earliest') saveSettings({ earliestStart: Number(e.target.value) });
    else if (e.target.id === 'plan-finish') saveSettings({ finishBeforeSunrise: Number(e.target.value) });
    else if (e.target.id === 'plan-hard') saveSettings({ hardDeadline: Number(e.target.value) });
  });
  // Enter moves to the next zone's run length, like a spreadsheet.
  view.addEventListener('keydown', e => {
    const input = e.target.closest('[data-dur]');
    if (!input || e.key !== 'Enter') return;
    e.preventDefault();
    const inputs = [...view.querySelectorAll('.prow:not([hidden]) [data-dur]')];
    // Moving focus fires the change that saves this one.
    const next = inputs[inputs.indexOf(input) + (e.shiftKey ? -1 : 1)];
    if (next) next.focus(); else input.blur();
  });

  return { render };
}
