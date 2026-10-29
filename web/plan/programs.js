// Two reviewed previews from the plan settings: rebalancing the zones' dates
// to even out nights, and the controller programs, as they are now and as the
// saved plan would compile to. From the programs sheet the owner can also
// install the reviewed plan, put the programs back, and rename them; each is a
// tracked command the server runs only while program writes are on.
import { $, $$, escape } from '../core/dom.js';
import { api } from '../core/api.js';
import { on } from '../core/app.js';
import { act, isBusy } from '../core/commands.js';
import { message } from '../core/message.js';
import { formatDuration } from '../../lib/planner.mjs';
import { ago, day } from '../core/format.js';
import { MONTH, clockAt } from '../model/plan.js';
import {
  nameProblem,
  programRecordText,
  programRow,
  programWrites,
  programsSummary,
  reviewRows,
} from '../model/programs.js';
import { checkDraft } from './draft.js';
import { intents, plan, rememberDraft, zones } from './state.js';

let proposal = null,
  reviewing = false,
  /** The last GET /api/programs, for the actions below the list. */
  programs = null,
  /** The install preview under review, with its token. */
  install = null;

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
            `<li><div class="program-head"><b>Program ${escape(g.slot)}</b><span class="num">${clockAt(g.startMinute)}${g.startDayOffset ? ' (+1 day)' : ''} · ${formatDuration(g.seconds)}</span></div><p>${g.steps.map(s => `${escape(s.name)} <span class="num">${formatDuration(s.seconds)}</span>`).join(' → ')}</p><small class="num">${g.eveningMask
              .map((on, d) => (on ? p.dates[d].slice(5).replace('-', '/') : null))
              .filter(Boolean)
              .join(', ')}</small></li>`,
        )
        .join('')}</ol>
      <details><summary>Night-by-night totals</summary><ul>${p.nights.map(n => `<li class="num">${n.date.slice(5).replace('-', '/')}: ${formatDuration(n.seconds)}${n.start == null ? '' : `, ${clockAt(n.start)}–${clockAt(n.finish)}`}${n.parallelSeconds ? `; ${formatDuration(n.parallelSeconds)} overlap` : ''}</li>`).join('')}</ul></details>
      <details><summary>Controller assumptions still to verify</summary><ul>${p.assumptions.map(a => `<li>${escape(a)}</li>`).join('')}</ul></details></section>`;
}

/** What the controller runs today, from the copy 2core last read. Read-only. */
async function showCurrentPrograms() {
  $('program-current').innerHTML = '<p class="muted">Reading the controller’s programs…</p>';
  try {
    const result = await api('/programs');
    programs = result;
    showProgramActions();
    const names = Object.fromEntries(zones().map(z => [z.id, z.name]));
    const rows = result.programs.map(p => programRow(p, names));
    $('program-current').innerHTML =
      `<section class="program-report"><h3>On the controller now</h3><p class="muted">${escape(programsSummary(result, ago, day))}</p>
      <ol class="programs">${rows
        .map(
          r =>
            `<li class="${r.active ? '' : 'off'}"><div class="program-head"><b>${escape(r.name)}</b><span class="num">${escape(r.when)}</span></div><small>${escape([r.days, ...r.notes].join(' · '))}</small><p>${r.steps.map(s => `${escape(s.name)} <span class="num">${escape(s.duration)}</span>`).join(' → ')}</p></li>`,
        )
        .join('')}</ol></section>`;
  } catch (e) {
    $('program-current').innerHTML =
      `<p class="muted">Couldn’t read the controller’s programs: ${escape(e.message)}</p>`;
  }
}

/** The writes note, the last program job, and what can be put back. */
function showProgramActions() {
  const writes = programWrites(programs);
  $('program-subtitle').textContent = writes.enabled ? 'Program writes are on' : 'Read-only · no controller changes';
  $('program-writes').textContent = writes.note;
  for (const id of ['start-rename', 'review-install', 'restore-programs', 'save-names'])
    $(id).disabled = !writes.enabled;
  const last = programs.tests?.[0];
  $('program-last').innerHTML = last
    ? `<p class="hint">Last program change, ${escape(ago(last.finishedAt ?? last.startedAt))}: ${escape(programRecordText(last))}</p>`
    : '';
  const backups = programs.installBackups ?? [];
  $('restore-hint').textContent = backups.length
    ? 'Each install first keeps the programs as they were. Putting them back replaces every program, names included, and syncs.'
    : 'Nothing to put back yet: each install keeps the programs as they were before it.';
  $('restore-backup').innerHTML = backups
    .map(
      (at, i) =>
        `<option value="${escape(at)}">${escape(day(at))}, ${escape(new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}${i ? '' : ' (latest)'}</option>`,
    )
    .join('');
  $('restore-choice').hidden = !backups.length;
  $('restore-programs').hidden = !backups.length;
  $('confirm-restore').hidden = true;
}

async function reviewInstall() {
  $('review-install').disabled = true;
  $('confirm-install').hidden = true;
  $('install-error').textContent = '';
  $('install-review').innerHTML = '<p class="muted">Preparing the review…</p>';
  try {
    install = await api('/programs/install-preview', {});
    const rows = reviewRows(install);
    if (install.status !== 'ready') {
      $('install-review').innerHTML =
        `<p>The plan can’t be installed yet:</p><ul>${install.issues.map(i => `<li>${escape(i.message)}</li>`).join('')}</ul>`;
      return;
    }
    $('install-review').innerHTML = rows.length
      ? `<p>${rows.length} program${rows.length === 1 ? '' : 's'} change · ${install.summary.messages} messages to Tucor.</p>
        <ul class="install-changes">${rows.map(r => `<li><b>${escape(r.name)}</b> (program ${r.slot})${r.off ? ' · switched off' : ''}<br><small>${r.changes.map(escape).join(' · ')}</small></li>`).join('')}</ul>
        ${install.warnings.map(w => `<p class="hint">${escape(w.message)}</p>`).join('')}
        <p class="hint">This review holds for today, while the plan and the controller’s programs stay as they are.</p>`
      : '<p>The controller already runs the saved plan. Nothing to install.</p>';
    $('confirm-install').hidden = !rows.length;
    $('confirm-install').disabled = !programWrites(programs).enabled;
  } catch (e) {
    $('install-review').innerHTML = '';
    $('install-error').textContent = `Couldn’t prepare the review: ${e.message}`;
  } finally {
    $('review-install').disabled = !programWrites(programs ?? {}).enabled;
  }
}

function startRename() {
  const current = programs?.programs ?? [];
  $('rename-list').innerHTML = current
    .map(
      p =>
        `<li><span class="num">${escape(p.id)}</span><input data-rename="${escape(p.id)}" value="${escape(p.name)}" maxlength="${escape(programs.capabilities?.nameLength ?? 12)}" autocomplete="off" aria-label="Name for program ${escape(p.id)}"><small data-rename-note="${escape(p.id)}"></small></li>`,
    )
    .join('');
  $('rename-error').textContent = '';
  $('program-rename').hidden = false;
  $('start-rename').hidden = true;
}
function stopRename() {
  $('program-rename').hidden = true;
  $('start-rename').hidden = false;
}
/** The names that changed, or null with the problems shown beside each field. */
function changedNames() {
  const max = programs.capabilities?.nameLength ?? 12;
  const names = {};
  let ok = true;
  for (const input of $$('[data-rename]')) {
    const id = input.dataset.rename,
      name = input.value;
    const problem = nameProblem(name, max);
    $(`rename-list`).querySelector(`[data-rename-note="${id}"]`).textContent = problem ?? '';
    if (problem) ok = false;
    else if (name !== programs.programs.find(p => p.id === id)?.name) names[id] = name;
  }
  return ok ? names : null;
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
    showCurrentPrograms();
    previewPrograms(Boolean(paused.length));
  });
  $('compare-programs').addEventListener('click', () => previewPrograms(true));

  $('review-install').addEventListener('click', reviewInstall);
  $('confirm-install').addEventListener('click', async () => {
    if (!install || isBusy()) return;
    $('confirm-install').hidden = true;
    $('install-review').innerHTML =
      '<p class="muted">Sent. The server writes, reads back and syncs; this can take a few minutes.</p>';
    await act('/programs/install', { token: install.token }, 'Sending the install…');
    install = null;
  });
  $('restore-programs').addEventListener('click', () => {
    $('restore-programs').hidden = true;
    $('confirm-restore').hidden = false;
  });
  $('confirm-restore').addEventListener('click', async () => {
    if (isBusy()) return;
    $('confirm-restore').hidden = true;
    await act('/programs/restore-before-install', { backup: $('restore-backup').value }, 'Sending the restore…');
  });
  $('start-rename').addEventListener('click', startRename);
  $('cancel-rename').addEventListener('click', stopRename);
  $('rename-list').addEventListener('input', () => changedNames());
  $('save-names').addEventListener('click', async () => {
    const names = changedNames();
    if (!names) return;
    if (!Object.keys(names).length) {
      $('rename-error').textContent = 'No names changed.';
      return;
    }
    stopRename();
    await act('/programs/rename', { names }, 'Sending the new names…');
  });
  // A finished program job changes what's on the controller: read it again.
  on('program-job', () => {
    if ($('program-dialog').open) showCurrentPrograms();
  });
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
