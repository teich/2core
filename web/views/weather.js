// Weather: the rain delay, the Tempest station and the automatic delay policy.
import { $, $$, html } from '../core/dom.js';
import { app, context } from '../core/app.js';
import { act, isBusy } from '../core/commands.js';
import { canControl } from '../model/zones.js';
import {
  MODE_TEXT,
  decisionSummary,
  depth,
  limit,
  policyRule,
  rainDelay,
  rainUnit,
  stationHealth,
} from '../model/weather.js';

const DECISION_ICON = {
  leaf: 'check',
  danger: 'alert',
  amber: 'alert',
  clock: 'clock',
  water: 'rain',
  'soft-water': 'rain',
};

function tile(label, configured, value, threshold, unit, unitLabel, sub, wet = value >= threshold) {
  const has = configured && value != null;
  return `<div class="reading${!has ? ' none' : wet ? ' wet' : ''}"><span class="label">${label}</span><strong>${has ? depth(value, unit) : '—'}<small>${unitLabel}</small></strong><div class="meter"><i data-fill="${has ? Math.min(100, (value / threshold) * 100) : 0}"></i></div><span class="sub">${!configured ? 'Not selected' : !has ? 'No reading' : wet ? 'Over threshold' : sub}</span></div>`;
}

function render() {
  const { state } = app,
    unit = rainUnit(state),
    policy = state.policy,
    now = Date.now(),
    ctx = context(now);

  const delay = rainDelay(state, unit, now);
  $('delay-card').classList.toggle('on', delay.on);
  $('delay-icon').className = `badge-icon${delay.on ? ' water' : ''}`;
  $('delay-title').textContent = delay.title;
  $('delay-detail').textContent = delay.detail;
  $('delay-meter').hidden = delay.meter == null;
  if (delay.meter != null) $('delay-fill').style.width = `${delay.meter}%`;
  $$('[data-rain]').forEach(b => (b.disabled = !canControl(ctx) || (b.dataset.rain === '0' && !delay.on)));

  const source = state.weatherSource,
    health = stationHealth(state, now);
  $('station-title').textContent =
    source?.source === 'Simulator' ? 'Simulated station' : source?.station?.name || 'Tempest';
  $('station-pill').className = `pill ${health.pill[1]}`;
  $('station-status').textContent = health.pill[0];
  $('station-note').textContent = health.note;

  const configured = Boolean(source?.configured),
    sample = configured && state.weatherReading?.sample,
    chance = sample?.forecastProbability;
  html(
    'readings',
    [
      tile(
        'Rain now',
        configured,
        sample?.intensityMmH,
        policy.intensityMmH,
        unit,
        `${unit}/h`,
        `Delays at ${limit(policy.intensityMmH, unit)}`,
      ),
      tile(
        'Today',
        configured,
        sample?.accumulationMm,
        policy.accumulationMm,
        unit,
        unit,
        `Delays at ${limit(policy.accumulationMm, unit)}`,
      ),
      // A forecast counts only when both its amount and its probability clear their thresholds.
      tile(
        'Next 12 h',
        configured,
        sample?.forecastMm,
        policy.forecastMm,
        unit,
        chance == null ? unit : `${unit} · ${Math.round(chance)}%`,
        `Delays at ${limit(policy.forecastMm, unit)}, ${policy.forecastProbability}%+`,
        sample?.forecastMm >= policy.forecastMm && chance >= policy.forecastProbability,
      ),
    ].join(''),
  );
  // The page's CSP forbids inline style attributes; set meter widths through the DOM.
  $$('#readings [data-fill]').forEach(el => (el.style.width = `${el.dataset.fill}%`));

  $$('[data-mode]').forEach(b => {
    b.setAttribute('aria-checked', String(b.dataset.mode === policy.mode));
    b.disabled = isBusy();
  });
  $('mode-explain').textContent =
    MODE_TEXT[policy.mode] +
    (policy.mode === 'automatic' && !state.controlEnabled
      ? ' Live control is off on the server, so nothing will be set.'
      : '');
  const decision = decisionSummary(state, unit, now);
  $('decision-icon').className = `badge-icon small ${decision.tone === 'clock' ? '' : decision.tone}`;
  $('decision-icon').innerHTML = `<svg><use href="#i-${DECISION_ICON[decision.tone]}"/></svg>`;
  $('decision-title').textContent = decision.title;
  $('decision-detail').textContent = decision.detail;
  $('policy-rule').textContent = policyRule(policy, unit);
}

export function mount() {
  $$('[data-rain]').forEach(b => b.addEventListener('click', () => act('/rain', { hours: Number(b.dataset.rain) })));
  $('policy-modes').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (b && b.getAttribute('aria-checked') !== 'true')
      act('/policy', { mode: b.dataset.mode }, 'Saving weather mode…');
  });
  return { render };
}
