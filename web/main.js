// Entry point: signs in, mounts every view, and runs the polling and tick timers.
// See AGENTS.md for how the web app is organized.
import { $, escape, html } from './core/dom.js';
import { api } from './core/api.js';
import { app, onFrame, on, register, tick } from './core/app.js';
import { heartbeat, interacted, load, prepare, resumed, HEARTBEAT_MS } from './core/commands.js';
import { message } from './core/message.js';
import { runningZones } from './model/zones.js';
import { createWaterFX } from './water.js';
import { createPlan } from './plan.js';
import * as shell from './views/shell.js';
import * as activity from './views/activity.js';
import * as zones from './views/zones.js';
import * as weather from './views/weather.js';
import * as walk from './views/walk.js';
import * as zoneSheet from './views/zone-sheet.js';
import * as findings from './views/findings.js';
import * as dock from './views/dock.js';

app.implicitAuth = await import('./auth.js').then(m => m.detectImplicitAuthentication()).catch(() => false);
app.key = sessionStorage.getItem('2core-key') || '';

const waterFX = createWaterFX();
const plan = createPlan({ $, api, escape, message, html, getState: () => app.state, zoneEnabled: waterFX.zoneEnabled });

// Registration order is render order.
register(shell.mount());
register(activity.mount());
register(zones.mount());
register(weather.mount());
register({ render: () => app.tab === 'plan' && plan.render() });
register(walk.mount({ tilt: waterFX.tilt }));
register(zoneSheet.mount({ plan, pour: waterFX.pour }));
register(findings.mount());
register(dock.mount());

on('outcome', event => waterFX.event(event));
// Every view's tick contributes part of the frame; the water effects draw it.
onFrame(frame =>
  waterFX.update({
    enabled: !$('application').hidden,
    tab: app.tab,
    modal: [...document.querySelectorAll('dialog')].some(d => d.open),
    running: app.reachable && app.state.available && runningZones(app.state).length > 0,
    sheet: false,
    vessel: null,
    tankState: null,
    capsule: null,
    ...frame,
  }),
);

document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('page-hidden', document.hidden);
  if (!document.hidden) resumed();
});
for (const type of ['pointerdown', 'keydown'])
  document.addEventListener(type, interacted, { capture: true, passive: true });
setInterval(heartbeat, HEARTBEAT_MS);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});
// Poll state while visible, except while zone details are being typed.
setInterval(() => {
  if (!document.hidden && !$('notes-dialog').open) load();
}, 1500);
setInterval(() => {
  if (!document.hidden) tick();
}, 1000);
prepare(true);
load();
