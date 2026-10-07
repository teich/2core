// Flagging problems and the findings list. Her eyes are the leak detector, so
// recording a problem is one tap.
import { $, escape, html, icon, pad } from '../core/dom.js';
import { app, context } from '../core/app.js';
import { day } from '../core/format.js';
import { act, isBusy, waitUntilIdle } from '../core/commands.js';
import { message } from '../core/message.js';
import { ISSUES, limitsOf, pendingOp, runningZones } from '../model/zones.js';

let flagZone = null,
  clearArmed = false;

const saveIssues = (zone, issues) => act(`/zones/${zone.id}/preferences`, { issues }, 'Saving…');

/** Rows for each flagged problem, with a remove button; also used by the zone sheet. */
export const issueRows = zones =>
  zones
    .flatMap(z =>
      (z.issues || []).map(
        (item, i) =>
          `<div class="fi"><span class="zone-num num">${pad(z.id)}</span><div><b>${escape(item.issue)}</b><span>${escape(z.name)} · ${day(item.at)}</span></div><button class="rm" data-unflag="${z.id}:${i}" aria-label="Remove ${escape(item.issue)} from ${escape(z.name)}" ${isBusy() ? 'disabled' : ''}>${icon('x')}</button></div>`,
      ),
    )
    .join('');

/** Opens the flag sheet for a zone. */
export function openFlag(id) {
  flagZone = app.state.zones.find(z => z.id === id);
  if (!flagZone) return;
  $('flag-number').textContent = pad(flagZone.id);
  $('flag-zone').textContent = flagZone.name;
  $('flag-options').innerHTML = ISSUES.map(
    i => `<button data-issue="${escape(i)}">${icon('flag')}${escape(i)}</button>`,
  ).join('');
  $('flag-dialog').showModal();
}

function renderFindings() {
  const zones = app.state.zones.filter(z => z.issues?.length),
    count = zones.reduce((n, z) => n + z.issues.length, 0);
  $('findings-summary').textContent = count
    ? `${count} problem${count > 1 ? 's' : ''} across ${zones.length} zone${zones.length > 1 ? 's' : ''}`
    : 'Nothing flagged. Tap Flag a problem during a walk.';
  html('findings-list', issueRows(zones));
  $('findings-actions').hidden = !count;
  $('findings-clear').textContent = clearArmed ? 'Tap again to clear all' : 'Clear all';
  $('findings-clear').disabled = isBusy();
}

export function mount() {
  $('close-flag').addEventListener('click', () => $('flag-dialog').close());
  $('close-findings').addEventListener('click', () => $('findings-dialog').close());
  $('flag-options').addEventListener('click', e => {
    const b = e.target.closest('[data-issue]');
    if (!b || !flagZone) return;
    const issues = [...(flagZone.issues || []), { issue: b.dataset.issue, at: new Date().toISOString() }].slice(
      -limitsOf(app.state).issues || -20,
    );
    $('flag-dialog').close();
    saveIssues(flagZone, issues);
  });
  $('findings-open').addEventListener('click', () => {
    clearArmed = false;
    renderFindings();
    $('findings-dialog').showModal();
  });
  // Remove buttons appear in both the findings list and the zone sheet.
  document.addEventListener('click', e => {
    const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-unflag]'));
    if (!b) return;
    const [id, index] = b.dataset.unflag.split(':');
    const zone = app.state.zones.find(z => z.id === id);
    if (zone)
      saveIssues(
        zone,
        zone.issues.filter((_, i) => i !== Number(index)),
      );
  });
  $('findings-copy').addEventListener('click', () => {
    const text = [
      'Irrigation findings',
      ...app.state.zones.flatMap(z => (z.issues || []).map(i => `Zone ${z.id} (${z.name}): ${i.issue}, ${day(i.at)}`)),
    ].join('\n');
    navigator.clipboard?.writeText(text).then(
      () => message('Copied the findings list.'),
      () => message('Couldn’t copy. Select the list and copy it instead.', true),
    );
  });
  // Clearing everything takes two taps, and saves zone by zone.
  $('findings-clear').addEventListener('click', async () => {
    if (!clearArmed) {
      clearArmed = true;
      renderFindings();
      return;
    }
    clearArmed = false;
    for (const zone of app.state.zones.filter(z => z.issues?.length)) {
      if (!(await waitUntilIdle())) break;
      await saveIssues(zone, []);
    }
    await waitUntilIdle();
    renderFindings();
  });

  return {
    render() {
      const open = $('findings-dialog').open;
      if (open) renderFindings();
      if (runningZones(app.state).length === 0 && !pendingOp(context())) clearArmed = clearArmed && open;
    },
  };
}
