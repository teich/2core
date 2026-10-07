// The zone sheet: a minute dial and tank to start a run, the live countdown
// while it waters, plus favorite, notes, flags and a link to the zone's plan.
import { $, $$, html, icon, pad } from '../core/dom.js';
import { app, context, tick } from '../core/app.js';
import { at, clock, duration, hm } from '../core/format.js';
import { act, isBusy, startZone } from '../core/commands.js';
import { readNumber, write } from '../core/storage.js';
import {
  blockedReason,
  canControl,
  describe,
  dialSteps,
  levelOf,
  limitsOf,
  pendingOp,
  stepIndex,
  waitText,
  zoneMode,
} from '../model/zones.js';
import { issueRows, openFlag } from './findings.js';

/** Pixels between dial ticks; matches `.tk` in styles/sheets.css. */
const TICK_PX = 10;
const steps = () => dialSteps(limitsOf(app.state));
const snap = m => steps()[stepIndex(steps(), m)];
const showsRun = (zone, mode) =>
  ['running', 'unknown', 'stopping'].includes(mode) || (mode === 'stale' && zone.running);

let deps = { plan: null, pour: _delta => {} };
let editing = null;

/** Opens the sheet for a zone. */
export function openZone(id) {
  app.selected = id;
  $('sheet-feedback').textContent = '';
  renderSheet();
  $('zone-dialog').showModal();
  requestAnimationFrame(() => setDial(app.minutes, false));
  tick();
}

function buildDial() {
  const max = limitsOf(app.state).maxMinutes;
  if ($('ticks').dataset.max === String(max)) return;
  $('ticks').dataset.max = String(max);
  $('ticks').setAttribute('aria-valuemax', String(max));
  // Past an hour each tick is five minutes: longer marks every quarter hour, labels every half hour.
  $('ticks').innerHTML = steps()
    .map(m => {
      const major = m < 60 ? m % 15 === 0 : m % 30 === 0,
        minor = m < 60 ? m % 5 === 0 : m % 15 === 0;
      return `<i class="tk${major ? ' m15' : minor ? ' m5' : ''}">${major || m === 1 ? `<span>${m < 60 ? m : hm(m)}</span>` : ''}</i>`;
    })
    .join('');
  $('duration-presets').innerHTML = [5, 15, 30, 60, 120, 240]
    .filter(m => m <= max)
    .map(m => `<button data-duration="${m}" aria-pressed="false">${m < 60 ? m : `${m / 60}h`}</button>`)
    .join('');
}

function setDial(m, smooth = true) {
  $('ticks').scrollTo({ left: stepIndex(steps(), m) * TICK_PX, behavior: smooth ? 'smooth' : 'instant' });
}

function renderSheet() {
  const zone = app.state?.zones.find(z => z.id === app.selected);
  if (!zone) return;
  buildDial();
  const ctx = context(),
    minutes = (app.minutes = snap(app.minutes));
  const mode = zoneMode(zone, ctx),
    info = describe(zone, mode, ctx),
    blocked = blockedReason(ctx);
  const showRun = showsRun(zone, mode);
  $('sheet-number').textContent = pad(zone.id);
  $('sheet-number').classList.toggle('flagged', Boolean(zone.issues?.length));
  $('sheet-name').textContent = zone.name;
  $('sheet-status').textContent = info.text || (zone.running ? '' : 'Not running');
  $('sheet-duration').hidden = showRun || mode === 'starting';
  $('dur-block').hidden = showRun;
  $('sheet-timer').hidden = !showRun;
  $('sheet-blocked').textContent = showRun || mode === 'starting' ? '' : blocked;
  $('sheet-start').hidden = showRun || mode === 'starting';
  $('sheet-start').disabled = Boolean(blocked);
  $('sheet-start').innerHTML = `${icon('drop')}Water for ${duration(minutes)}`;
  $('sheet-stop').hidden = !(zone.running && zone.owned) || mode === 'stopping';
  $('sheet-stop').disabled = !canControl(ctx);
  const planText = deps.plan.describeZone(zone.id);
  $('sheet-plan').hidden = !planText;
  $('sheet-plan-text').textContent = planText ?? '';
  $('sheet-favorite').setAttribute('aria-pressed', String(zone.favorite));
  $('sheet-favorite').setAttribute('aria-label', zone.favorite ? 'Remove from favorites' : 'Add to favorites');
  for (const id of ['sheet-favorite', 'edit-zone', 'sheet-flag']) $(id).disabled = isBusy();
  html('sheet-issues', issueRows([zone]));
  $('sheet-notes').textContent = zone.notes || '';
  $('duration-value').textContent = minutes < 60 ? minutes : hm(minutes);
  $('duration-unit').textContent = minutes < 60 ? 'min' : minutes === 60 ? 'hour' : 'hours';
  $('ticks').setAttribute('aria-valuenow', String(minutes));
  $('ticks').setAttribute('aria-valuetext', duration(minutes));
  $$('[data-duration]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.duration) === minutes)));
}

/** The tank under the dial: how full, and in which state, for the water effects. */
function tank(zone, now) {
  const ctx = context(now),
    mode = zoneMode(zone, ctx);
  $('sheet-status').textContent = describe(zone, mode, ctx).text || 'Not running';
  if (showsRun(zone, mode)) {
    const known = zone.endsAt && zone.owned;
    $('sheet-timer').textContent = known ? clock(Date.parse(zone.endsAt) - now) : 'Watering';
    $('tank-caption').innerHTML = known ? `left · ends at <b>${at(Date.parse(zone.endsAt))}</b>` : 'End time unknown';
    return { mode, level: levelOf(zone, mode, now), tone: 'water', frost: mode === 'stale' };
  }
  if (mode === 'starting') {
    $('tank-caption').textContent = waitText(pendingOp(ctx), now);
    return { mode: 'starting', level: 0, tone: 'water', frost: false };
  }
  $('tank-caption').innerHTML = `Ends at <b>${at(now + app.minutes * 60000)}</b> if started now`;
  return {
    mode: 'idle',
    level: 0.06 + (0.86 * stepIndex(steps(), app.minutes)) / (steps().length - 1),
    tone: mode === 'failed' ? 'amber' : 'water',
    frost: !app.reachable || !app.state.available,
  };
}

/**
 * @param {{ plan: { describeZone: (id: string) => string | null, openZone: (id: string) => void },
 *   pour: (delta: number) => void }} options
 *   `pour` animates water into the tank when the dial moves by `delta` steps.
 */
export function mount(options) {
  deps = options;
  app.minutes = readNumber('2core-minutes', 30);

  $('close-zone').addEventListener('click', () => $('zone-dialog').close());
  // Minute dial: scroll to choose; the tank fills with the water the run will use.
  $('ticks').addEventListener(
    'scroll',
    () => {
      const all = steps(),
        index = Math.max(0, Math.min(all.length - 1, Math.round($('ticks').scrollLeft / TICK_PX)));
      const m = all[index];
      if (m === app.minutes) return;
      deps.pour(index - stepIndex(all, app.minutes));
      app.minutes = m;
      write('2core-minutes', m);
      renderSheet();
      tick();
    },
    { passive: true },
  );
  $('ticks').addEventListener('keydown', e => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (step) {
      const all = steps();
      e.preventDefault();
      setDial(all[Math.max(0, Math.min(all.length - 1, stepIndex(all, app.minutes) + step))]);
    }
  });
  $('duration-presets').addEventListener('click', e => {
    const b = e.target.closest('[data-duration]');
    if (b) setDial(Number(b.dataset.duration));
  });
  $('sheet-start').addEventListener('click', () => startZone(app.selected, app.minutes));
  $('sheet-stop').addEventListener('click', () => act(`/zones/${app.selected}/stop`));
  $('sheet-favorite').addEventListener('click', () => {
    const z = app.state.zones.find(z => z.id === app.selected);
    act(`/zones/${app.selected}/preferences`, { favorite: !z.favorite }, 'Saving favorite…');
  });
  $('sheet-plan').addEventListener('click', () => {
    const id = app.selected;
    $('zone-dialog').close();
    deps.plan.openZone(id);
  });
  $('sheet-flag').addEventListener('click', () => {
    const id = app.selected;
    $('zone-dialog').close();
    openFlag(id);
  });

  // Zone details: name, walking order and notes.
  $('edit-zone').addEventListener('click', () => {
    editing = app.state.zones.find(z => z.id === app.selected);
    $('notes-title').textContent = `Zone ${editing.id}`;
    $('zone-name').value = editing.name;
    $('zone-order').value = editing.order;
    $('zone-notes').value = editing.notes;
    $('zone-dialog').close();
    $('notes-dialog').showModal();
  });
  $('cancel-notes').addEventListener('click', () => {
    $('notes-dialog').close();
    openZone(editing.id);
  });
  $('notes-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (isBusy()) return;
    const body = { name: $('zone-name').value, notes: $('zone-notes').value, order: Number($('zone-order').value) };
    $('notes-dialog').close();
    openZone(editing.id);
    await act(`/zones/${editing.id}/preferences`, body, 'Saving zone details…');
  });

  return {
    render: renderSheet,
    tick(now) {
      const zone = app.state.zones.find(z => z.id === app.selected);
      const tankState = $('zone-dialog').open && zone ? tank(zone, now) : null;
      return { sheet: Boolean(tankState), tankState };
    },
  };
}
