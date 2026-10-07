// Walk: step through zones in order, watering each briefly to check it.
// Walking never advances on its own; "Next" stops this zone and starts the next.
import { $, $$, escape, html, icon, pad } from '../core/dom.js';
import { app, context, render, tick } from '../core/app.js';
import { clock } from '../core/format.js';
import { act, isBusy, startZone } from '../core/commands.js';
import { readNumber, write } from '../core/storage.js';
import {
  blockedReason,
  canControl,
  describe,
  levelOf,
  nextZone,
  opTarget,
  pendingOp,
  runningZones,
  walkZones,
  zoneMode,
} from '../model/zones.js';
import { openFlag } from './findings.js';
import { onTab } from './shell.js';
import { openZone } from './zone-sheet.js';
import { showUnused } from './zones.js';

const zones = () => walkZones(app.state.zones, showUnused());
/** The zone on the vessel: the chosen one, else the running one, else the first. */
const current = () => zones().find(z => z.id === app.walkId) || zones().find(z => z.running) || zones()[0];

let railShown = null;

function renderWalk() {
  const list = zones(),
    zone = current(),
    ctx = context();
  if (zone) app.walkId = zone.id;
  $('walk-position').textContent = zone ? `${list.findIndex(z => z.id === zone.id) + 1} of ${list.length}` : 'No zones';
  const count = app.state.zones.reduce((n, z) => n + (z.issues?.length || 0), 0);
  $('findings-count').textContent = count;
  $('findings-count').classList.toggle('hot', count > 0);
  html(
    'walk-rail',
    list
      .map(
        z =>
          `<button data-walk="${z.id}" class="${z.running ? 'running' : ''}${z.issues?.length ? ' flagged' : ''}" aria-label="Zone ${z.id}, ${escape(z.name)}" aria-pressed="${z.id === app.walkId}"><b>${pad(z.id)}</b><span>${escape(z.name)}</span></button>`,
      )
      .join(''),
  );
  $('walk-number').textContent = zone ? `ZONE ${pad(zone.id)}` : 'ZONE';
  if (zone && railShown !== zone.id && app.tab === 'walk') {
    railShown = zone.id;
    requestAnimationFrame(() =>
      $('walk-rail')
        .querySelector('[aria-pressed=true]')
        ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }),
    );
  }
  $('walk-name').textContent = zone?.name || 'No zones';
  const running = runningZones(app.state);
  const active = running.some(z => z.owned) || Boolean(opTarget(pendingOp(ctx)));
  const next = nextZone(list, running[0]?.id || zone?.id);
  $('walk-start').hidden = active;
  $('walk-start').disabled = !zone || Boolean(blockedReason(ctx));
  $('walk-start').innerHTML = zone ? `${icon('drop')}Start zone ${pad(zone.id)} · ${app.walkMinutes} min` : 'Start';
  $('walk-transport').hidden = !active;
  $('next-zone').innerHTML = next ? `<span>Next: ${escape(next.name)}</span>${icon('next')}` : 'Next';
  $('next-zone').setAttribute('aria-label', next ? `Stop this zone and start ${next.name}` : 'Next');
  $('next-zone').disabled =
    !canControl(ctx) ||
    !next ||
    (app.state.available && (running.some(z => !z.owned) || Number(app.state.status.rainShutDown) > 0));
  $('walk-stop').disabled = !canControl(ctx) || !running.some(z => z.owned);
  $('walk-flag').disabled = !zone || isBusy();
  $('walk-details').disabled = !zone;
  $$('[data-walk-minutes]').forEach(b => {
    b.setAttribute('aria-checked', String(Number(b.dataset.walkMinutes) === app.walkMinutes));
    b.disabled = isBusy();
  });
}

/** The vessel's countdown and status, and its frame for the water effects. */
function vessel(now) {
  const ctx = context(now),
    zone = current(),
    mode = zoneMode(zone, ctx),
    info = describe(zone, mode, ctx),
    blocked = blockedReason(ctx);
  // The countdown is the big number; the name is the heading above the vessel.
  const big = mode === 'idle' ? clock(app.walkMinutes * 60000) : info.short;
  const word = mode === 'running' ? 'left' : mode === 'idle' ? 'Ready' : '';
  $('walk-time').textContent = big;
  $('walk-word').textContent = word;
  $('walk-state').textContent = info.text;
  $('walk-state').className = `walk-state ${info.cls}`;
  $('walk-detail').textContent =
    ['idle', 'failed'].includes(mode) && blocked && !zone?.running
      ? blocked
      : zone?.issues?.length
        ? `Flagged: ${zone.issues.map(i => i.issue).join(', ')}`
        : (zone?.notes || '').split('\n')[0];
  const level = zone ? levelOf(zone, mode, now) : 0;
  $('water-orb').classList.toggle('watering', ['running', 'unknown'].includes(mode) && app.tab === 'walk');
  $('water-orb').querySelector('.water-level').style.transform = `translate3d(0,${(1 - level) * 100}%,0)`;
  if (!zone) return null;
  return {
    mode: mode === 'offline' ? 'stale' : mode === 'failed' ? 'idle' : mode,
    level,
    label: `ZONE ${pad(zone.id)}`,
    big,
    word,
    tone: info.tone,
    frost: mode === 'stale' || mode === 'offline',
  };
}

/**
 * @param {{ tilt: { available: boolean, toggle: () => Promise<boolean>, set: (on: boolean) => Promise<boolean> } }} options
 *   Phone-tilt control for the vessel's water, from the water effects.
 */
export function mount({ tilt }) {
  app.walkMinutes = readNumber('2core-walk-minutes', 1);
  onTab(() => (railShown = null));

  $('walk-rail').addEventListener('click', e => {
    const b = e.target.closest('[data-walk]');
    if (b) {
      app.walkId = b.dataset.walk;
      renderWalk();
      tick();
    }
  });
  $$('[data-walk-minutes]').forEach(b =>
    b.addEventListener('click', () => {
      app.walkMinutes = Number(b.dataset.walkMinutes);
      write('2core-walk-minutes', app.walkMinutes);
      renderWalk();
    }),
  );
  $('walk-start').addEventListener('click', () => startZone(current().id, app.walkMinutes));
  $('walk-details').addEventListener('click', () => openZone(current().id));
  $('walk-stop').addEventListener('click', () => act('/stop'));
  $('walk-flag').addEventListener('click', () => openFlag(current()?.id));
  $('next-zone').addEventListener('click', async () => {
    if (isBusy() || $('next-zone').disabled) return;
    const running = runningZones(app.state);
    const next = nextZone(zones(), running[0]?.id || current()?.id);
    app.walkId = next.id;
    if (!running.length) {
      render();
      $('walk-rail').querySelector('[aria-pressed=true]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
      return;
    }
    // One accepted operation owns both steps, even while the phone is locked.
    await act(`/zones/${next.id}/next`, { minutes: app.walkMinutes });
  });

  let motion = false;
  try {
    motion = localStorage.getItem('2core-motion-enabled') === 'true';
  } catch {
    /* use the default */
  }
  $('tilt').addEventListener('click', async () => {
    motion = await tilt.toggle();
    write('2core-motion-enabled', motion);
    $('tilt').setAttribute('aria-pressed', String(motion));
  });
  if (motion) tilt.set(true).then(enabled => $('tilt').setAttribute('aria-pressed', String(enabled)));

  return {
    render() {
      renderWalk();
      $('tilt').hidden = !tilt.available;
    },
    tick: now => ({ vessel: vessel(now) }),
  };
}
