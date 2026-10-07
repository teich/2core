// Two reviewed, read-only previews from the plan settings: rebalancing the
// zones' dates to even out nights, and the controller programs the saved plan
// would compile to (a dry run; nothing is installed).
import { $, $$, escape } from '../core/dom.js';
import { api } from '../core/api.js';
import { message } from '../core/message.js';
import { formatDuration } from '../../lib/planner.mjs';
import { MONTH, clockAt } from '../model/plan.js';
import { checkDraft } from './draft.js';
import { intents, plan, rememberDraft, zones } from './state.js';

let proposal = null,
  reviewing = false;

/** `2026-07-04` → `Jul 4`. */
const pretty = key => {
  const [, m, d] = key.split('-').map(Number);
  return `${MONTH[m - 1]} ${d}`;
};

async function reviewRebalance() {
  if (reviewing) return;
  reviewing = true;
  try {
    proposal = await api('/plan/rebalance-preview', {});
    const p = proposal,
      names = Object.fromEntries(zones().map(z => [z.id, z.name]));
    $('rebalance-summary').textContent = p.changes.length
      ? `Move ${p.changes.length} zone${p.changes.length === 1 ? '' : 's'}. Over the next 12 weeks, the busiest night drops from ${formatDuration(p.beforePeakSeconds)} to ${formatDuration(p.afterPeakSeconds)} of watering.`
      : 'No useful rebalance found. Watering dates can stay as they are.';
    $('rebalance-changes').innerHTML = p.changes
      .map(
        c =>
          `<li><b>${escape(names[c.zone] ?? `Zone ${c.zone}`)}</b><span class="num">${pretty(c.before)} → ${pretty(c.after)}</span><small>${Math.abs(c.days)} day${Math.abs(c.days) === 1 ? '' : 's'} ${c.days > 0 ? 'later — a longer wait this time' : 'earlier — a shorter gap this time'}, then the usual rhythm.</small></li>`,
      )
      .join('');
    $('rebalance-error').textContent = '';
    $('confirm-rebalance').hidden = !p.changes.length;
    $('confirm-rebalance').disabled = false;
    $('cancel-rebalance').textContent = p.changes.length ? 'Keep current dates' : 'Close';
    if ($('plan-settings-dialog').open) $('plan-settings-dialog').close();
    $('rebalance-dialog').showModal();
  } catch (e) {
    message(`Couldn’t prepare the rebalance: ${e.message}`, true);
  } finally {
    reviewing = false;
  }
}

function programReport(p, title) {
  const stats = p.summary;
  const summary = `${stats.zones} zones · ${stats.programs} of 10 programs · ${formatDuration(stats.weeklySeconds)} a week`;
  if (p.status !== 'candidate')
    return `<section class="program-report"><h3>${escape(title)}</h3><p class="muted">${summary}</p><p>No complete candidate yet.</p><ul>${p.issues.map(i => `<li>${escape(i.message)}</li>`).join('')}</ul></section>`;
  return `<section class="program-report"><h3>${escape(title)}</h3><p class="muted">${summary}</p>
      <p>${stats.maxConcurrent <= 1 ? 'One zone at a time.' : `Up to ${stats.maxConcurrent} zones at once; ${formatDuration(stats.parallelSeconds)} of overlap across 14 nights.`} ${stats.minimumOverlapProven ? 'Minimum overlap for this window.' : 'Overlap may be reducible.'} ${stats.preferredWindowMet ? 'Fits before' : 'Uses time after'} the ${clockAt(p.horizon.preferredFinish)} target.${p.horizon.sunriseKnown ? '' : ' Sunrise is estimated.'}</p>
      <ol class="programs">${p.programs
        .map(
          g =>
            `<li><div class="program-head"><b>Program ${escape(g.slot)}</b><span class="num">${clockAt(g.startMinute)}${g.startDayOffset ? ' (+1 day)' : ''} · ${formatDuration(g.seconds)}</span></div>${g.waterDuringRain ? '<small>Waters during rain</small>' : ''}<p>${g.steps.map(s => `${escape(s.name)} <span class="num">${formatDuration(s.seconds)}</span>`).join(' → ')}</p><small class="num">${g.eveningMask
              .map((on, d) => (on ? p.dates[d].slice(5).replace('-', '/') : null))
              .filter(Boolean)
              .join(', ')}</small></li>`,
        )
        .join('')}</ol>
      <details><summary>Night-by-night totals</summary><ul>${p.nights.map(n => `<li class="num">${n.date.slice(5).replace('-', '/')}: ${formatDuration(n.seconds)}${n.start == null ? '' : `, ${clockAt(n.start)}–${clockAt(n.finish)}`}${n.parallelSeconds ? `; ${formatDuration(n.parallelSeconds)} overlap` : ''}</li>`).join('')}</ul></details>
      <details><summary>Controller assumptions still to verify</summary><ul>${p.assumptions.map(a => `<li>${escape(a)}</li>`).join('')}</ul></details></section>`;
}

/** Compiles the saved plan; `compare` adds a run with the checked paused zones on. */
async function previewPrograms(compare = false) {
  $('program-error').textContent = 'Compiling the saved plan…';
  $('compare-programs').disabled = true;
  $('program-results').innerHTML = '';
  try {
    const base = await api('/plan/program-preview', {});
    let reports = programReport(base, 'Saved plan');
    if (compare) {
      const enabledOverrides = Object.fromEntries($$('#program-overrides input:checked').map(i => [i.value, true]));
      if (Object.keys(enabledOverrides).length)
        reports += programReport(await api('/plan/program-preview', { enabledOverrides }), 'With selected zones on');
    }
    $('program-results').innerHTML = reports;
    $('program-error').textContent = '';
  } catch (e) {
    $('program-error').textContent = `Couldn’t compile: ${e.message}`;
  } finally {
    $('compare-programs').disabled = false;
  }
}

export function mount() {
  $('plan-programs').addEventListener('click', () => {
    const paused = zones().filter(z => intents()[z.id]?.enabled === false);
    $('program-overrides').innerHTML = paused.length
      ? `<legend>Compare with zones that are off for now</legend>${paused.map(z => `<label><input type="checkbox" value="${escape(z.id)}" checked>${escape(z.name)}</label>`).join('')}`
      : '';
    $('program-overrides').hidden = !paused.length;
    $('compare-programs').hidden = !paused.length;
    $('plan-settings-dialog').close();
    $('program-dialog').showModal();
    previewPrograms(Boolean(paused.length));
  });
  $('compare-programs').addEventListener('click', () => previewPrograms(true));
  $('close-programs').addEventListener('click', () => $('program-dialog').close());

  $('plan-rebalance').addEventListener('click', reviewRebalance);
  $('review-rebalance').addEventListener('click', reviewRebalance);
  $('dismiss-rebalance').addEventListener('click', () => {
    $('rebalance-prompt').hidden = true;
  });
  for (const id of ['cancel-rebalance', 'close-rebalance'])
    $(id).addEventListener('click', () => $('rebalance-dialog').close());
  // Confirming stages the reviewed proposal's token and checks it like any edit.
  $('confirm-rebalance').addEventListener('click', async () => {
    if (!proposal) return;
    $('confirm-rebalance').disabled = true;
    try {
      plan.edit.rebalanceToken = proposal.token;
      rememberDraft();
      $('rebalance-dialog').close();
      $('rebalance-prompt').hidden = true;
      proposal = null;
      plan.review = null;
      await checkDraft(true);
    } catch (e) {
      $('rebalance-error').textContent = `${e.message} Close this review and review again before confirming.`;
    }
  });
}
