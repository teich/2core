// The run capsule above the tab bar: the running zone (or the one being
// started) with its countdown and a stop button, on every view but Walk.
import { $ } from '../core/dom.js';
import { app, context } from '../core/app.js';
import { clock } from '../core/format.js';
import { act } from '../core/commands.js';
import { canControl, describe, levelOf, opTarget, pendingOp, runningZones, zoneMode } from '../model/zones.js';
import { openZone } from './zone-sheet.js';

const capsuleZone = ctx => {
  const op = opTarget(pendingOp(ctx));
  return (
    runningZones(ctx.state)[0] || (op?.action === 'start' ? ctx.state.zones.find(z => z.id === op.zone) : undefined)
  );
};

export function mount() {
  $('stop').addEventListener('click', () => act('/stop'));
  for (const id of ['active-open', 'dock-open'])
    $(id)?.addEventListener('click', () => {
      const z = capsuleZone(context());
      if (z) openZone(z.id);
    });

  return {
    tick(now) {
      const ctx = context(now),
        zone = capsuleZone(ctx),
        mode = zoneMode(zone, ctx);
      // On Walk the vessel already shows the run, so the capsule would only cover the controls.
      $('run-dock').hidden = !zone || app.tab === 'walk';
      if (!zone) return { capsule: null };
      const info = describe(zone, mode, ctx);
      $('dock-name').textContent = zone.name;
      $('dock-time').textContent =
        mode === 'running' ? `${clock(Date.parse(zone.endsAt) - now)} left` : info.text || info.short;
      $('run-dock').classList.toggle('wait', mode === 'starting' || mode === 'stopping');
      $('stop').hidden = !(zone.running && zone.owned) || mode === 'stopping';
      $('stop').disabled = !canControl(ctx);
      return { capsule: { mode: mode === 'offline' ? 'stale' : mode, level: levelOf(zone, mode, now) } };
    },
  };
}
