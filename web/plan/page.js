// The Plan page: a status line, a strip of fourteen nights, the selected
// night's timeline, and a row per zone with its rhythm and next watering.
import { $, escape, html, icon } from '../core/dom.js';
import { app } from '../core/app.js';
import {
  FALLBACK_SUNRISE,
  NIGHTS,
  addDays,
  adjustedSeconds,
  cadenceLabel,
  currentNight,
  dateKey,
  formatDuration,
} from '../../lib/planner.mjs';
import {
  MONTH,
  NEEDS,
  NIGHT_STATUS,
  WD,
  WEEKDAY,
  clockAt,
  clockShort,
  nightLabel,
  shortSeconds,
} from '../model/plan.js';
import { checkDraft } from './draft.js';
import { problemZones, renderFit } from './fit.js';
import { renderSettings } from './settings-sheet.js';
import { blank, hasDraft, intents, plan, project, settings, zones } from './state.js';
import { renderZoneSheet } from './zone-sheet.js';

let rowsKey = '',
  stripKey = '';
/** Dims a row for a paused zone; supplied by the water effects. */
let zoneEnabled = (_row, _off) => {};

/** The page's CSP forbids inline style attributes; position through the DOM. */
function place(root) {
  root.querySelectorAll('[data-left]').forEach(el => {
    el.style.left = `${el.dataset.left}%`;
  });
  root.querySelectorAll('[data-width]').forEach(el => {
    el.style.width = `${el.dataset.width}%`;
  });
}

/** Row skeletons; render() fills them in place so polling doesn't rebuild them. */
function build(list) {
  $('plan-rows').innerHTML = list
    .map(
      z => `<button class="pz" data-row="${z.id}" data-plan-zone="${z.id}">
      <span class="zone-num num">${String(z.id).padStart(2, '0')}</span>
      <span class="pz-text"><b>${escape(z.name)}</b><small data-meta></small></span>
      <span class="pz-end"><span class="pnext" data-next></span><span class="pdots" data-cells aria-hidden="true"></span></span>
    </button>`,
    )
    .join('');
}

const cellsRendered = new WeakMap();

export function render() {
  const state = app.state;
  if (!state?.plan) return;
  // Re-apply a draft restored from sessionStorage once the saved plan is known.
  if (!plan.restored) {
    plan.restored = true;
    if (hasDraft()) {
      for (const [id, patch] of Object.entries(plan.edit.intents ?? {}))
        plan.drafts.set(id, { ...blank(), ...state.plan.intents[id], ...patch });
      plan.settingsDraft = { ...state.plan.settings, ...plan.edit.settings };
      queueMicrotask(() => checkDraft(false));
    }
  }
  // Check the saved plan again whenever it (or the night it starts from) changes.
  const fitKey = JSON.stringify([state.plan, state.location, dateKey(currentNight())]);
  if (!plan.busy && !hasDraft() && fitKey !== plan.checkedKey) {
    plan.checkedKey = fitKey;
    queueMicrotask(() => checkDraft(false));
  }
  const list = zones(),
    cfg = settings(),
    all = intents();
  const { start, plan: resolved } = project(all, cfg);
  plan.latest = { start, plan: resolved, all };
  plan.night = Math.min(plan.night, NIGHTS - 1);
  const names = Object.fromEntries(list.map(z => [z.id, z.name]));

  renderFit(resolved);
  renderSettings(cfg, list, all);

  // Filters
  const todo = resolved.zones.filter(z => NEEDS.has(z.problem)).length;
  if (todo === 0) plan.needsOnly = false;
  $('plan-all').setAttribute('aria-pressed', String(!plan.needsOnly));
  $('plan-needs').setAttribute('aria-pressed', String(plan.needsOnly));
  $('plan-needs').parentElement.hidden = todo === 0;
  $('plan-needs-count').textContent = todo;
  $('plan-needs-count').classList.toggle('hot', todo > 0);

  renderStrip(resolved, start, cfg);
  renderNight(resolved.nights[plan.night], plan.night, start, names, cfg);
  renderRows(list, resolved, start, all);
  renderZoneSheet();
}

function renderRows(list, resolved, start, all) {
  const key = list.map(z => `${z.id}:${z.name}`).join('|');
  if (key !== rowsKey) {
    rowsKey = key;
    build(list);
  }
  const byId = Object.fromEntries(resolved.zones.map(z => [z.id, z])),
    flagged = problemZones(),
    selected = plan.night;
  let shown = 0;
  for (const z of list) {
    const row = $('plan-rows').querySelector(`[data-row="${z.id}"]`),
      p = byId[z.id],
      intent = all[z.id] ?? blank();
    const hidden = plan.needsOnly && !NEEDS.has(p.problem);
    row.hidden = hidden;
    if (!hidden) shown++;
    zoneEnabled(row, intent.enabled === false);
    const seconds = adjustedSeconds(intent),
      pct = intent.seasonalPercent ?? 100;
    const rhythm = `${formatDuration(seconds)} · ${cadenceLabel(intent.cadence)}${pct !== 100 ? ` · ${pct}%` : ''}`;
    const meta =
      p.problem === 'unset'
        ? ['Needs a run length and how often', 'warn']
        : p.problem === 'duration'
          ? [`${cadenceLabel(intent.cadence)} · add a run length`, 'warn']
          : p.problem === 'cadence'
            ? [`${formatDuration(seconds)} · choose how often`, 'warn']
            : p.problem === 'paused'
              ? ['Off for now · settings kept', '']
              : flagged.has(z.id)
                ? [`${rhythm} · needs adjustment`, 'warn']
                : [rhythm, ''];
    row.classList.toggle('todo', NEEDS.has(p.problem) || flagged.has(z.id));
    row.classList.toggle('tonight', p.cells[selected]?.kind === 'water');
    const metaEl = row.querySelector('[data-meta]');
    metaEl.textContent = meta[0];
    metaEl.className = meta[1];
    const next = p.problem ? '' : p.next < 0 ? 'Later' : nightLabel(start, p.next);
    const nextEl = row.querySelector('[data-next]');
    nextEl.textContent = next;
    nextEl.classList.toggle('soon', p.next === 0 && !p.problem);
    const dots = p.problem
      ? ''
      : p.cells
          .map((c, d) => `<i class="${c.kind}${c.late ? ' late' : ''}${d === selected ? ' sel' : ''}"></i>`)
          .join('');
    const cells = row.querySelector('[data-cells]');
    if (cellsRendered.get(cells) !== dots) {
      cells.innerHTML = dots;
      cellsRendered.set(cells, dots);
    }
    row.setAttribute('aria-label', `${z.name}. ${meta[0]}.${next ? ` Next: ${next}.` : ''} Edit schedule`);
  }
  $('plan-empty').hidden = shown > 0;
  $('plan-empty').textContent = plan.needsOnly
    ? 'Every zone has a plan.'
    : 'No named zones yet. Check the controller connection.';
}

function renderStrip(resolved, start, cfg) {
  const span = cfg.hardDeadline + 1440 - cfg.earliestStart,
    selected = plan.night;
  const strip = resolved.nights
    .map((n, d) => {
      const date = addDays(start, d);
      const fill = n.start == null ? 0 : Math.max(8, Math.min(100, Math.round(((n.finish - n.start) / span) * 100)));
      const label =
        n.status === 'rain'
          ? 'rain hold'
          : n.status === 'over'
            ? `${n.deferred.length} don’t fit`
            : n.start == null
              ? 'nothing due'
              : `done ${clockAt(n.finish)}`;
      return `<button class="nd ${n.status}${d === selected ? ' sel' : ''}" data-night="${d}" aria-pressed="${d === selected}" aria-label="${WEEKDAY[date.getDay()]} ${MONTH[date.getMonth()]} ${date.getDate()}: ${label}"><small>${d === 0 ? 'Tonight' : WD[date.getDay()]}</small><b class="num">${date.getDate()}</b><span class="bar">${n.rain ? icon('rain') : `<i data-width="${fill}"></i>`}</span></button>`;
    })
    .join('');
  html('plan-nights', strip);
  place($('plan-nights'));
  // Keep the chosen night in view when it changes, without fighting a user's scroll.
  const key = `${dateKey(start)}:${selected}`;
  if (key !== stripKey) {
    stripKey = key;
    const button = $('plan-nights').querySelector('.sel'),
      box = $('plan-nights');
    if (button && box.clientWidth)
      box.scrollTo({
        left: Math.max(0, button.offsetLeft - box.clientWidth / 2 + button.offsetWidth / 2),
        behavior: 'smooth',
      });
  }
}

/** Notes under the night's timeline: rain holds, late zones, what doesn't fit. */
function nightNotes(n, names, cfg) {
  const notes = [
    ...(n.held.length
      ? [
          [
            'rain',
            `${n.held.map(id => names[id]).join(', ')} ${n.held.length > 1 ? 'wait' : 'waits'} for the next clear night.`,
          ],
        ]
      : []),
    ...(n.rain && n.start != null
      ? [
          [
            'rain',
            'Covered zones keep their planned watering during rain. This preview does not bypass the controller’s rain delay.',
          ],
        ]
      : []),
    ...Object.values(Object.groupBy(n.late, l => `${l.nights}:${l.reason}`)).map(group => {
      const { nights, reason } = group[0],
        who = group.map(l => names[l.zone]).join(', ');
      return [
        'warn',
        `${who} ${group.length > 1 ? 'water' : 'waters'} ${nights} night${nights > 1 ? 's' : ''} late after ${reason === 'rain' ? 'waiting out rain' : 'not fitting an earlier night'}.`,
      ];
    }),
    ...n.deferred.map(id => ['bad', `${names[id]} doesn’t fit and waits for the next night.`]),
    ...(n.needMinutes
      ? [
          [
            'bad',
            `This night needs at least ${formatDuration(n.needMinutes * 60)} more, an earlier start, a later deadline, or another zone at once.`,
          ],
        ]
      : []),
  ];
  if (!n.sunriseKnown)
    notes.push([
      '',
      `Sunrise is unknown until the Tempest reports its location, so the plan aims for ${clockAt(1440 + FALLBACK_SUNRISE - cfg.finishBeforeSunrise)}.`,
    ]);
  return notes;
}

function renderNight(n, d, start, names, cfg) {
  const date = addDays(start, d),
    morning = addDays(start, d + 1);
  const lo = Math.min(n.earliestStart, n.start ?? Infinity) - 15,
    hi = Math.max(n.hardDeadline, n.sunrise) + 15,
    span = hi - lo;
  const pos = m => Math.max(0, Math.min(100, ((m - lo) / span) * 100)).toFixed(3);
  const [status, tone] = NIGHT_STATUS[n.status](n);
  const ticks = [];
  for (let m = Math.ceil(lo / 180) * 180; m <= hi; m += 180)
    ticks.push(`<span data-left="${pos(m)}">${clockShort(m)}</span>`);
  const tracks = (n.lanes[1]?.length ? [0, 1] : [0])
    .map(
      i =>
        `<div class="track">${(n.lanes[i] ?? []).map(r => `<i class="run${r.late ? ' late' : ''}" data-left="${pos(r.from)}" data-width="${(((r.to - r.from) / span) * 100).toFixed(3)}"></i>`).join('')}</div>`,
    )
    .join('');
  const runs = n.lanes.flatMap((lane, i) => lane.map(r => ({ ...r, lane: i }))).sort((a, b) => a.from - b.from);
  const notes = nightNotes(n, names, cfg);
  const tried = plan.whatIf.has(n.date),
    held = n.rain && !tried;
  html(
    'night-card',
    `
      <div class="night-head">
        <div><p class="muted">${WD[date.getDay()]} ${MONTH[date.getMonth()]} ${date.getDate()} → ${WD[morning.getDay()]} morning</p><h2>${d === 0 ? 'Tonight' : d === 1 ? 'Tomorrow night' : `${WEEKDAY[date.getDay()]} night`}</h2></div>
        <span class="pill ${tone}"><i class="dot"></i>${status}</span>
      </div>
      ${
        n.start == null
          ? ''
          : `<dl class="night-stats num">
        <div><dt>Starts</dt><dd>${clockAt(n.start)}</dd></div>
        <div><dt>Done</dt><dd>${clockAt(n.finish)}</dd></div>
        <div><dt>Water</dt><dd title="${formatDuration(n.seconds)}">${shortSeconds(n.seconds)}</dd></div>
        <div><dt>Zones</dt><dd>${runs.length}</dd></div>
      </dl>`
      }
      <div class="night-bar" aria-hidden="true">
        <div class="tracks"><i class="window-before" data-width="${pos(n.earliestStart)}"></i><i class="window-after" data-left="${pos(n.hardDeadline)}"></i>${tracks}<i class="mark aim" data-left="${pos(n.preferredFinish)}"></i><i class="mark sun" data-left="${pos(n.sunrise)}"></i></div>
        <div class="axis num">${ticks.join('')}</div>
      </div>
      <p class="night-legend num"><span><i class="k-aim"></i>Aim ${clockAt(n.preferredFinish)}</span><span><i class="k-sun"></i>Sunrise ${clockAt(n.sunrise)}</span><span><i class="k-hard"></i>Never past ${clockAt(n.hardDeadline)}</span></p>
      ${
        runs.length
          ? `<ol class="night-runs">${runs.map(r => `<li><button data-plan-zone="${escape(r.zone)}"><span class="num">${clockAt(r.from)}</span><b>${escape(names[r.zone])}</b><small class="num">${formatDuration(r.seconds)}${r.late ? ` · ${r.late} late` : ''}</small>${r.lane ? '<em>2nd zone</em>' : ''}</button></li>`).join('')}</ol>`
          : `<p class="night-empty">${n.rain ? 'Rain hold · nothing waters this night' : n.deferred.length ? 'Nothing fits this night' : 'Nothing is due this night'}</p>`
      }
      ${notes.length ? `<ul class="night-notes">${notes.map(([tone, text]) => `<li class="${tone}">${escape(text)}</li>`).join('')}</ul>` : ''}
      ${held ? '<p class="hint">The controller’s rain delay covers this night.</p>' : `<button class="chip try-rain" data-whatif="${n.date}" aria-pressed="${tried}">${icon('rain')}${tried ? 'Rain hold on · tap to clear' : 'What if it rains?'}</button>`}`,
  );
  place($('night-card'));
}

/**
 * @param {{ zoneEnabled: (row: HTMLElement, off: boolean) => void, openZone: (id: string) => void }} options
 */
export function mount(options) {
  zoneEnabled = options.zoneEnabled;
  $('plan-view').addEventListener('click', e => {
    const night = e.target.closest('[data-night]'),
      rain = e.target.closest('[data-whatif]'),
      zone = e.target.closest('[data-plan-zone]');
    if (night) {
      plan.night = Number(night.dataset.night);
      render();
    } else if (rain) {
      const date = rain.dataset.whatif;
      plan.whatIf.has(date) ? plan.whatIf.delete(date) : plan.whatIf.add(date);
      render();
    } else if (zone) options.openZone(zone.dataset.planZone);
    else if (e.target.closest('#plan-all')) {
      plan.needsOnly = false;
      render();
    } else if (e.target.closest('#plan-needs')) {
      plan.needsOnly = true;
      render();
    }
  });
}
