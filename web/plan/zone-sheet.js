// The plan's zone sheet: run length, how often, seasonal percentage, on/off and
// rain behavior for one zone, previewed live before it is staged and checked.
import { $, html } from '../core/dom.js';
import { app } from '../core/app.js';
import {
  CADENCES,
  MAX_SECONDS,
  adjustedSeconds,
  cadenceFromKey,
  cadenceKey,
  cadenceLabel,
  durationText,
  formatDuration,
  parseDuration,
} from '../../lib/planner.mjs';
import { clampPercent, nightLabel, same, stepMinutes } from '../model/plan.js';
import { checkDraft, stageIntent } from './draft.js';
import { blank, intents, plan, project, zones } from './state.js';

const COMMON_CADENCES = [{ every: 1 }, { every: 2 }, { perWeek: 3 }, { perWeek: 2 }, { every: 7 }];
const PRESET_MINUTES = [5, 10, 15, 20, 30, 45, 60];
const FIELDS = ['seconds', 'cadence', 'enabled', 'waterDuringRain', 'seasonalPercent'];

/** The zone being edited; `typed` holds run-length text that doesn't parse yet. */
let sheet = null;
let showAllCadences = false;

export function openZone(id) {
  const zone = zones().find(z => z.id === id);
  if (!zone || !app.state?.plan) return;
  sheet = { id, intent: { ...blank(), ...intents()[id] }, typed: null };
  showAllCadences =
    Boolean(sheet.intent.cadence) && !COMMON_CADENCES.some(c => cadenceKey(c) === cadenceKey(sheet.intent.cadence));
  $('pz-error').textContent = '';
  $('pz-minutes').value = durationText(sheet.intent.seconds);
  $('pz-seasonal').value = sheet.intent.seasonalPercent ?? 100;
  renderZoneSheet();
  if (!$('plan-zone-dialog').open) $('plan-zone-dialog').showModal();
}

/** Fields that differ from the saved intent. */
function sheetPatch() {
  const saved = { ...blank(), ...intents()[sheet.id] },
    patch = {};
  for (const key of FIELDS) if (!same(saved[key], sheet.intent[key])) patch[key] = sheet.intent[key];
  return patch;
}

/** Re-renders the sheet if it is open. */
export function renderZoneSheet() {
  if (!sheet) return;
  const zone = zones().find(z => z.id === sheet.id);
  if (!zone) {
    $('plan-zone-dialog').close();
    return;
  }
  const intent = sheet.intent,
    on = intent.enabled !== false;
  $('pz-number').textContent = String(zone.id).padStart(2, '0');
  $('pz-name').textContent = zone.name;
  $('pz-enabled').checked = on;
  $('pz-fields').classList.toggle('off', !on);
  $('pz-minutes')
    .closest('.stepper')
    .classList.toggle('invalid', sheet.typed != null);
  html(
    'pz-presets',
    PRESET_MINUTES.map(
      m => `<button type="button" data-preset="${m}" aria-pressed="${intent.seconds === m * 60}">${m}</button>`,
    ).join(''),
  );
  const choices = showAllCadences ? CADENCES : COMMON_CADENCES;
  const offered =
    intent.cadence && !choices.some(c => cadenceKey(c) === cadenceKey(intent.cadence))
      ? [...choices, intent.cadence]
      : choices;
  html(
    'pz-cadence',
    offered
      .map(
        c =>
          `<button type="button" role="radio" data-cadence="${cadenceKey(c)}" aria-checked="${cadenceKey(c) === cadenceKey(intent.cadence)}">${cadenceLabel(c)}</button>`,
      )
      .join('') + (showAllCadences ? '' : '<button type="button" class="more" data-cadence="more">More…</button>'),
  );
  // The controller repeats on a fourteen-day calendar; say so before the check does.
  $('pz-cadence-hint').textContent =
    intent.cadence?.every && 14 % intent.cadence.every
      ? `The controller repeats every two weeks, so “${cadenceLabel(intent.cadence)}” can’t be installed exactly. Every 2 days, 2–3× a week, or weekly can.`
      : '';
  const pct = intent.seasonalPercent ?? 100,
    adjusted = adjustedSeconds(intent);
  $('pz-seasonal-hint').textContent = !intent.seconds
    ? 'Scales the run length for the season.'
    : pct === 100
      ? 'Runs at the full length.'
      : `Runs ${formatDuration(adjusted)} instead of ${formatDuration(intent.seconds)}.`;
  $('pz-rain').checked = intent.waterDuringRain === true;
  // Preview this zone with the unsaved values to show what they mean.
  const preview = project({ ...intents(), [sheet.id]: intent }).plan.zones.find(z => z.id === sheet.id);
  $('pz-summary').textContent =
    sheet.typed != null
      ? 'Enter a run length from 1 second to 4 hours'
      : preview?.problem === 'paused'
        ? 'Off · settings kept'
        : preview?.problem
          ? 'Needs a run length and how often'
          : `≈ ${formatDuration(Math.round(preview.weeklySeconds / 60) * 60)} a week · next ${preview.next < 0 ? 'in more than two weeks' : nightLabel(plan.latest.start, preview.next).toLowerCase()}`;
  const changed = Object.keys(sheetPatch()).length > 0;
  $('pz-save').disabled = plan.busy || sheet.typed != null || !changed;
  $('pz-save').textContent = plan.busy ? 'Checking…' : 'Save';
}

function setMinutes(seconds, fromTyping = false) {
  sheet.intent.seconds = seconds;
  sheet.typed = null;
  if (!fromTyping) $('pz-minutes').value = durationText(seconds);
  renderZoneSheet();
}

function setPercent(value) {
  sheet.intent.seasonalPercent = clampPercent(value);
  $('pz-seasonal').value = sheet.intent.seasonalPercent;
  renderZoneSheet();
}

export function mount() {
  $('plan-zone-dialog').addEventListener('click', e => {
    if (!sheet) return;
    const step = e.target.closest('[data-step]'),
      preset = e.target.closest('[data-preset]'),
      cadence = e.target.closest('[data-cadence]');
    if (step) {
      const [field, dir] = step.dataset.step.split(':'),
        direction = Number(dir);
      if (field === 'minutes')
        setMinutes(sheet.intent.seconds ? stepMinutes(sheet.intent.seconds / 60, direction) * 60 : 600);
      else setPercent((sheet.intent.seasonalPercent ?? 100) + direction * 5);
    } else if (preset) setMinutes(Number(preset.dataset.preset) * 60);
    else if (cadence) {
      if (cadence.dataset.cadence === 'more') showAllCadences = true;
      else sheet.intent.cadence = cadenceFromKey(cadence.dataset.cadence);
      renderZoneSheet();
    }
  });
  $('pz-minutes').addEventListener('input', () => {
    const seconds = parseDuration($('pz-minutes').value);
    if (seconds == null) {
      sheet.intent.seconds = null;
      sheet.typed = null;
      renderZoneSheet();
      return;
    }
    if (Number.isNaN(seconds) || seconds > MAX_SECONDS || seconds === 0) {
      sheet.typed = $('pz-minutes').value;
      renderZoneSheet();
      return;
    }
    setMinutes(seconds, true);
  });
  $('pz-minutes').addEventListener('change', () => {
    if (sheet.typed == null) $('pz-minutes').value = durationText(sheet.intent.seconds);
  });
  $('pz-seasonal').addEventListener('change', () => {
    const value = Number($('pz-seasonal').value);
    setPercent(Number.isFinite(value) && $('pz-seasonal').value !== '' ? value : 100);
  });
  $('pz-enabled').addEventListener('change', () => {
    sheet.intent.enabled = $('pz-enabled').checked;
    renderZoneSheet();
  });
  $('pz-rain').addEventListener('change', () => {
    sheet.intent.waterDuringRain = $('pz-rain').checked;
    renderZoneSheet();
  });
  $('pz-cancel').addEventListener('click', () => $('plan-zone-dialog').close());
  $('pz-close').addEventListener('click', () => $('plan-zone-dialog').close());
  $('plan-zone-dialog').addEventListener('close', () => {
    sheet = null;
  });
  $('pz-save').addEventListener('click', async () => {
    if (!sheet || plan.busy || sheet.typed != null) return;
    const patch = sheetPatch(),
      id = sheet.id;
    if (!Object.keys(patch).length) {
      $('plan-zone-dialog').close();
      return;
    }
    stageIntent(id, patch);
    $('plan-zone-dialog').close();
    await checkDraft(true);
  });
}
