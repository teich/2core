// The frame around every view: sign-in, header, tabs and shared dialog behavior.
import { $, $$ } from '../core/dom.js';
import { app, context, on, render, tick } from '../core/app.js';
import { act, isBusy, load, prepare, showPending } from '../core/commands.js';
import { connectionStatus } from '../model/connection.js';

const TITLES = { zones: 'Zones', walk: 'Walk', plan: 'Watering plan', rain: 'Weather', activity: 'Activity' };

/** Switches the visible view. */
export function showTab(name) {
  app.tab = name;
  document.body.dataset.view = name;
  $('view-title').textContent = TITLES[name];
  $$('[data-tab]').forEach(b =>
    b.dataset.tab === name ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'),
  );
  for (const view of Object.keys(TITLES)) $(`${view}-view`).hidden = view !== name;
  window.scrollTo({ top: 0, behavior: 'instant' });
  for (const fn of tabListeners) fn(name);
  render();
}
/** @type {((tab: string) => void)[]} */
const tabListeners = [];
export const onTab = fn => void tabListeners.push(fn);

export function mount() {
  on('loaded', () => {
    $('login').hidden = true;
    $('application').hidden = false;
    $('dock').hidden = false;
    $('signout').hidden = app.implicitAuth;
    $('login-error').textContent = '';
  });
  on('load-failed', text => ($('login-error').textContent = text));

  $('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    app.key = $('access-key').value.trim();
    sessionStorage.setItem('2core-key', app.key);
    prepare(true);
    await load();
  });
  $('signout').addEventListener('click', () => {
    sessionStorage.removeItem('2core-key');
    location.reload();
  });
  $('refresh').addEventListener('click', () => act('/refresh'));
  // The status pill checks now when paused, and explains when 2core is holding back.
  $('connection').addEventListener('click', () =>
    app.state?.connection?.retryAt || app.state?.error ? showTab('activity') : act('/refresh'),
  );
  $$('[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('close', tick);
    // Tapping the dimmed backdrop closes a sheet.
    d.addEventListener('click', e => {
      if (e.target === d) d.close();
    });
  }
  fetch('/healthz')
    .then(r => r.json())
    .then(info => ($('demo-hint').hidden = info.mode !== 'demo'))
    .catch(() => {});

  return {
    render() {
      const { state } = app;
      showPending();
      const [text, tone] = connectionStatus(context());
      $('connection-text').textContent = text;
      $('connection').className = `status ${tone}`;
      $('mode-note').hidden = state.mode !== 'demo' && state.controlEnabled;
      $('mode-note').textContent =
        state.mode === 'demo'
          ? 'Simulation. Controls never reach real irrigation.'
          : 'Read-only. Watering is turned off on the server.';
      $('refresh').disabled = isBusy();
    },
    tick(now) {
      if (app.reachable) $('connection-text').textContent = connectionStatus(context(now))[0];
    },
  };
}
