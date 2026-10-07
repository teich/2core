// The plan's settings sheet: the night window, zones at once, seasonal
// adjustment for all zones, and which zones the seasonal comparison checks.
import { $, $$, escape, html } from '../core/dom.js';
import { app } from '../core/app.js';
import { clampPercent, clockAt, clockShort } from '../model/plan.js';
import { checkDraft, saveSettings } from './draft.js';
import { blank, hasDraft, intents, plan, rememberDraft, settings, zones } from './state.js';

const SELECTS = [
  ['plan-earliest', 'earliestStart'],
  ['plan-finish', 'finishBeforeSunrise'],
  ['plan-hard', 'hardDeadline'],
];

export function renderSettings(cfg = settings(), list = zones(), all = intents()) {
  $('plan-window').textContent = `${clockShort(cfg.earliestStart)}–${clockShort(cfg.hardDeadline + 1440)}`;
  const percentages = new Set(list.map(z => all[z.id]?.seasonalPercent ?? 100));
  const commonPercent = percentages.size === 1 ? [...percentages][0] : null;
  $('seasonal-status').textContent =
    plan.busy && Object.hasOwn(plan.edit, 'seasonalPercent')
      ? '…'
      : commonPercent == null
        ? 'Mixed'
        : `${commonPercent}%`;
  if (!plan.seasonalEdited && document.activeElement !== $('seasonal-all'))
    $('seasonal-all').value = commonPercent ?? '';
  $('seasonal-all').placeholder = 'Mixed';
  for (const id of ['seasonal-all', 'seasonal-apply']) $(id).disabled = plan.busy || !list.length;
  for (const [id, k] of SELECTS) {
    const select = $(id),
      value = String(cfg[k]);
    // Keep a saved value selectable even when it isn't one of the offered options.
    if (![...select.options].some(o => o.value === value))
      select.add(new Option(k === 'finishBeforeSunrise' ? `${cfg[k]} min before sunrise` : clockAt(cfg[k]), value));
    if (document.activeElement !== select) select.value = value;
    select.disabled = plan.busy;
  }
  $$('[data-lanes]').forEach(b => {
    b.setAttribute('aria-checked', String(Number(b.dataset.lanes) === cfg.lanes));
    b.disabled = plan.busy;
  });
  for (const id of ['plan-rebalance', 'review-rebalance', 'plan-programs']) $(id).disabled = plan.busy || hasDraft();
  const selectedIds =
    plan.edit.seasonalZoneIds ?? plan.review?.plan?.seasonalZoneIds ?? app.state.plan.seasonalZoneIds ?? [];
  html(
    'fit-seasonal-zones',
    list
      .map(
        z =>
          `<label><input type="checkbox" data-fit-seasonal="${z.id}"${selectedIds.includes(z.id) ? ' checked' : ''}${plan.busy ? ' disabled' : ''}>${escape(z.name)}</label>`,
      )
      .join(''),
  );
}

/** Opens the sheet, optionally scrolled to a section's id. */
function openSettings(section) {
  renderSettings();
  $('plan-settings-dialog').showModal();
  if (section) $(section).scrollIntoView({ block: 'start' });
}

export function mount() {
  $('plan-open-night').addEventListener('click', () => openSettings('settings-night'));
  $('plan-open-seasonal').addEventListener('click', () => openSettings('settings-seasonal'));
  $('plan-open-settings').addEventListener('click', () => openSettings());
  $('close-plan-settings').addEventListener('click', () => $('plan-settings-dialog').close());
  const sheet = $('plan-settings-dialog');
  sheet.addEventListener('click', e => {
    const lanes = e.target.closest('[data-lanes]'),
      step = e.target.closest('[data-step]');
    if (lanes && lanes.getAttribute('aria-checked') !== 'true') saveSettings({ lanes: Number(lanes.dataset.lanes) });
    else if (step) {
      const value = Number($('seasonal-all').value) || 100;
      $('seasonal-all').value = clampPercent(value + Number(step.dataset.step.split(':')[1]) * 5);
      plan.seasonalEdited = true;
    }
  });
  sheet.addEventListener('change', e => {
    if (e.target.id === 'plan-earliest') saveSettings({ earliestStart: Number(e.target.value) });
    else if (e.target.id === 'plan-finish') saveSettings({ finishBeforeSunrise: Number(e.target.value) });
    else if (e.target.id === 'plan-hard') saveSettings({ hardDeadline: Number(e.target.value) });
    else if (e.target.matches('[data-fit-seasonal]') && !plan.busy) {
      plan.edit.seasonalZoneIds = $$('#fit-seasonal-zones input:checked').map(i => i.dataset.fitSeasonal);
      rememberDraft();
      plan.review = null;
      checkDraft(true);
    }
  });
  $('seasonal-all').addEventListener('input', () => {
    plan.seasonalEdited = true;
  });
  $('seasonal-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!$('seasonal-all').reportValidity()) return;
    const seasonalPercent = Number($('seasonal-all').value);
    if (plan.busy) return;
    // A later all-zones adjustment supersedes earlier per-zone percentage drafts.
    for (const [id, patch] of Object.entries(plan.edit.intents ?? {})) {
      delete patch.seasonalPercent;
      if (!Object.keys(patch).length) delete plan.edit.intents[id];
    }
    if (plan.edit.intents && !Object.keys(plan.edit.intents).length) delete plan.edit.intents;
    plan.edit.seasonalPercent = seasonalPercent;
    rememberDraft();
    for (const z of zones()) plan.drafts.set(z.id, { ...blank(), ...intents()[z.id], seasonalPercent });
    plan.review = null;
    await checkDraft(true);
  });
}
