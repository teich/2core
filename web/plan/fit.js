// The plan's status line and the review sheet: whether the saved plan or the
// unsaved change fits overnight, its trade-offs, and verified fixes.
import { $, escape, html, icon } from '../core/dom.js';
import { app } from '../core/app.js';
import { clockAt, consequenceText, editLines } from '../model/plan.js';
import { applyReviewed, checkDraft, discardDraft } from './draft.js';
import { hasDraft, plan, zoneName } from './state.js';
import { openZone } from './zone-sheet.js';

const TONE = { busy: '', error: 'danger', none: '', fits: 'leaf', consequence: 'amber', 'needs-adjustment': 'amber' };
const GLYPH = { error: 'alert', consequence: 'alert', 'needs-adjustment': 'alert' };

/** Zones the latest check says need an adjustment. */
export const problemZones = () =>
  new Set(
    (plan.review?.assessment?.scenarios ?? [])
      .filter(r => r.status === 'needs-adjustment')
      .flatMap(r => r.zoneIds ?? []),
  );

const problemText = r => {
  const names = (r.zoneIds ?? []).map(zoneName);
  return names.length ? `${names.join(', ')}: ${r.message}` : r.message;
};
const lines = () => editLines(plan.edit, app.state.plan.intents, zoneName);

/** Closes the other plan sheets and opens the review sheet. */
export function openReview() {
  for (const id of ['plan-zone-dialog', 'plan-settings-dialog']) if ($(id).open) $(id).close();
  renderFit();
  if (!$('plan-review-dialog').open) $('plan-review-dialog').showModal();
}

/** @param {any} [resolved] The resolved plan, for the saved plan's summary line. */
export function renderFit(resolved) {
  const report = plan.review?.assessment,
    draft = hasDraft();
  const status = plan.busy ? 'busy' : plan.error ? 'error' : !report ? 'none' : report.status;
  const tone = TONE[status],
    glyph = GLYPH[status] ?? 'check';

  // Status line on the page.
  const failing = report?.scenarios.find(r => r.status === 'needs-adjustment');
  const trade = report?.scenarios.map(consequenceText).find(Boolean);
  let title,
    detail = '';
  if (status === 'busy') title = draft ? 'Checking your change…' : 'Checking the plan…';
  else if (draft) {
    title =
      status === 'error'
        ? 'Couldn’t check your change'
        : status === 'none'
          ? 'Unsaved change'
          : status === 'fits'
            ? 'Your change fits · tap to save'
            : 'Unsaved change needs review';
    detail = lines()
      .map(([who, what]) => `${who}: ${what}`)
      .join(' · ');
  } else if (status === 'error') {
    title = 'Couldn’t check the plan';
    detail = plan.error;
  } else if (status === 'needs-adjustment') {
    title = 'Needs an adjustment';
    detail = problemText(failing);
  } else if (status === 'consequence') {
    title = 'Fits, with a trade-off';
    detail = trade;
  } else title = status === 'fits' ? 'Fits overnight' : 'Watering plan';
  if (resolved && !draft && (status === 'fits' || status === 'none' || status === 'busy')) {
    const planned = resolved.zones.filter(z => !z.problem).length,
      open = resolved.nights.filter(n => n.start != null);
    const last = open.reduce((a, n) => (!a || n.finish > a.finish ? n : a), null);
    detail = [`${planned} of ${resolved.zones.length} zones planned`, last && `latest finish ${clockAt(last.finish)}`]
      .filter(Boolean)
      .join(' · ');
  }
  $('plan-status').dataset.tone = draft && status !== 'busy' ? 'draft' : tone;
  $('plan-status-icon').className = `badge-icon small ${draft && status !== 'busy' ? 'soft-water' : tone}`;
  $('plan-status-icon').innerHTML = icon(draft ? 'pencil' : glyph);
  $('plan-status-title').textContent = title;
  $('plan-status-detail').textContent = detail;

  // Review sheet.
  $('plan-fit-icon').className = `badge-icon small ${tone}`;
  $('plan-fit-icon').innerHTML = icon(glyph);
  $('plan-fit-title').textContent =
    status === 'busy'
      ? 'Checking…'
      : status === 'error'
        ? 'Couldn’t check'
        : status === 'none'
          ? draft
            ? 'Unsaved change'
            : 'Watering plan check'
          : status === 'fits'
            ? draft
              ? 'Your change fits'
              : 'Fits overnight'
            : status === 'consequence'
              ? 'Fits, with a trade-off'
              : 'Needs an adjustment';
  $('plan-fit-state').textContent = draft ? 'Not saved yet' : 'Saved plan';
  html(
    'plan-fit-edit',
    lines()
      .map(([who, what]) => `<li><b>${escape(who)}</b><span>${escape(what)}</span></li>`)
      .join(''),
  );
  const scenarios = report?.scenarios ?? [];
  html(
    'plan-fit-scenarios',
    scenarios
      .map(r => {
        const seasonal =
          r.id === 'current' ? '' : ` (${(plan.review.seasonalZones ?? []).map(z => z.name).join(', ')})`;
        const text =
          r.status === 'needs-adjustment'
            ? problemText(r)
            : consequenceText(r) ||
              `Fits ${r.maxConcurrent === 2 ? 'with up to two zones at once' : 'with one zone at a time'}.`;
        const fix =
          r.status === 'needs-adjustment'
            ? (r.zoneIds ?? [])
                .map(
                  id =>
                    `<button class="soft" data-fit-zone="${escape(id)}">${icon('pencil')}Edit ${escape(zoneName(id))}</button>`,
                )
                .join('')
            : '';
        return `<div class="fit-scenario ${r.status}">${scenarios.length > 1 ? `<b>${escape(r.label + seasonal)}</b>` : ''}<p>${escape(text)}${r.sunriseKnown === false ? ' Sunrise is estimated.' : ''}</p>${fix ? `<div class="fit-fixes">${fix}</div>` : ''}<details><summary>Details</summary><p>${escape(r.detail)}</p></details></div>`;
      })
      .join(''),
  );
  html(
    'plan-fit-alternatives',
    (plan.review?.alternatives ?? []).length
      ? `<h3>Verified fixes</h3>${plan.review.alternatives.map(a => `<article><p>${escape(a.description)}</p><button class="primary" data-fit-alternative="${a.id}"${plan.busy ? ' disabled' : ''}>Use this and save</button></article>`).join('')}`
      : report?.status === 'needs-adjustment' && draft
        ? '<p class="hint">No verified fix found. Edit the change, or save it as an unfinished plan; this doesn’t prove your goal is impossible.</p>'
        : '',
  );
  $('plan-fit-error').textContent = plan.error;
  $('fit-check').hidden = !draft || (report && !plan.error);
  $('fit-save').hidden = !draft || !report || report.status === 'needs-adjustment';
  $('fit-unfinished').hidden = !draft || report?.status !== 'needs-adjustment';
  $('fit-discard').hidden = !draft;
  for (const id of ['fit-check', 'fit-save', 'fit-unfinished', 'fit-discard']) $(id).disabled = plan.busy;
  $('fit-save').textContent = report?.status === 'consequence' ? 'Save anyway' : 'Save';
}

export function mount() {
  $('plan-status').addEventListener('click', () => {
    if (hasDraft() && plan.review?.assessment.status === 'fits' && !plan.busy) applyReviewed();
    else openReview();
  });
  $('fit-close').addEventListener('click', () => $('plan-review-dialog').close());
  $('fit-check').addEventListener('click', () => checkDraft(false));
  $('fit-save').addEventListener('click', () => applyReviewed());
  $('fit-unfinished').addEventListener('click', () => applyReviewed(null, true));
  $('fit-discard').addEventListener('click', discardDraft);
  $('plan-review-dialog').addEventListener('click', e => {
    const alternative = e.target.closest('[data-fit-alternative]'),
      fix = e.target.closest('[data-fit-zone]');
    if (alternative && !plan.busy) applyReviewed(alternative.dataset.fitAlternative);
    else if (fix) {
      $('plan-review-dialog').close();
      openZone(fix.dataset.fitZone);
    }
  });
}
