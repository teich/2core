// Publishing: the bar at the top of the Plan tab says whether the controller
// runs the saved plan, and its sheet reviews the edits since the last publish,
// what they change over the next two weeks, then publishes or discards them.
// Edits save to the plan as before; nothing reaches Tucor until Publish.
import { $, escape } from '../core/dom.js';
import { api } from '../core/api.js';
import { app, on } from '../core/app.js';
import { act, isBusy, load } from '../core/commands.js';
import { message } from '../core/message.js';
import { day } from '../core/format.js';
import { reviewRows } from '../model/programs.js';
import { editLines, minuteLines, nightLines, publishBar, windowNote } from '../model/publish.js';
import { zones } from './state.js';

/** The install preview under review, with its token. */
let review = null;

const names = () => Object.fromEntries(zones().map(z => [z.id, z.name]));
const list = (id, lines) => {
  $(id).innerHTML = lines.map(l => `<li><b>${escape(l.title)}</b><small>${escape(l.detail)}</small></li>`).join('');
  $(`${id}-section`).hidden = !lines.length;
};

export function render() {
  const publish = app.state?.publish;
  const bar = publishBar(publish, day);
  $('publish-bar').hidden = !bar;
  if (!bar) return;
  $('publish-bar').dataset.tone = bar.tone;
  $('publish-bar-title').textContent = bar.title;
  $('publish-bar-detail').textContent = bar.detail;
  $('publish-bar-action').textContent = bar.action;
}

async function open() {
  review = null;
  for (const id of ['publish-edits', 'publish-nights', 'publish-minutes']) $(`${id}-section`).hidden = true;
  $('publish-programs-section').hidden = true;
  $('publish-warnings').innerHTML = '';
  $('publish-window').textContent = '';
  $('publish-error').textContent = '';
  $('publish-confirm').hidden = true;
  $('publish-discard-confirm').hidden = true;
  $('publish-status').textContent = 'Preparing the review…';
  const publish = app.state?.publish;
  $('publish-subtitle').textContent = publish?.message ?? '';
  $('publish-discard').hidden = !publish?.edits?.zones.length && !publish?.edits?.settings.length;
  $('publish-dialog').showModal();
  try {
    review = await api('/programs/install-preview', {});
    show();
  } catch (e) {
    $('publish-status').textContent = '';
    $('publish-error').textContent = `Couldn’t prepare the review: ${e.message}`;
  }
}

function show() {
  const zoneNames = names(),
    publish = app.state?.publish;
  if (review.edits) list('publish-edits', editLines(review.edits, zoneNames, app.state?.plan?.intents));
  else $('publish-edits-section').hidden = true;
  if (review.status !== 'ready') {
    $('publish-status').innerHTML =
      `The plan can’t be published yet:<ul>${review.issues.map(i => `<li>${escape(i.message)}</li>`).join('')}</ul>`;
    return;
  }
  const rows = reviewRows(review);
  list('publish-nights', nightLines(review.impact, zoneNames));
  list('publish-minutes', minuteLines(review.impact, zoneNames));
  $('publish-programs').innerHTML = rows
    .map(
      r =>
        `<li><b>${escape(r.name)}</b> (program ${r.slot})${r.off ? ' · switched off' : ''}<br><small>${r.changes.map(escape).join(' · ')}</small></li>`,
    )
    .join('');
  $('publish-programs-section').hidden = !rows.length;
  $('publish-warnings').innerHTML = review.warnings.map(w => `<p class="hint">${escape(w.message)}</p>`).join('');
  $('publish-window').textContent = windowNote(review.window);
  if (!rows.length) {
    $('publish-status').textContent = 'The controller already runs the saved plan. Nothing to publish.';
    return;
  }
  $('publish-status').textContent =
    `${rows.length} program${rows.length === 1 ? '' : 's'} change. This review holds for today, while the plan and the controller’s programs stay as they are.`;
  $('publish-confirm').hidden = false;
  const blocked = !publish?.writesEnabled
    ? 'Program writes are off on the server (ALLOW_PROGRAM_WRITES), so publishing can’t run.'
    : !review.window.open
      ? windowNote(review.window)
      : '';
  $('publish-confirm').disabled = Boolean(blocked);
  if (blocked) $('publish-error').textContent = blocked;
}

export function mount() {
  $('publish-bar').addEventListener('click', open);
  $('close-publish').addEventListener('click', () => $('publish-dialog').close());
  $('publish-confirm').addEventListener('click', async () => {
    if (!review || isBusy()) return;
    $('publish-confirm').hidden = true;
    $('publish-discard').hidden = true;
    $('publish-status').textContent =
      'Sent. The server writes the programs, reads them back and syncs; this can take a few minutes.';
    await act('/programs/install', { token: review.token }, 'Publishing the plan…');
    review = null;
  });
  $('publish-discard').addEventListener('click', () => {
    $('publish-discard').hidden = true;
    $('publish-discard-confirm').hidden = false;
  });
  $('publish-discard-confirm').addEventListener('click', async () => {
    $('publish-discard-confirm').disabled = true;
    try {
      await api('/plan/discard-unpublished', { token: app.state?.publish?.token });
      $('publish-dialog').close();
      message('Back to the published plan.');
      load();
    } catch (e) {
      $('publish-error').textContent = e.message;
    } finally {
      $('publish-discard-confirm').disabled = false;
      $('publish-discard-confirm').hidden = true;
    }
  });
  // A finished program job changes what's on the controller: review it again.
  on('program-job', () => {
    if ($('publish-dialog').open) open();
  });
}
