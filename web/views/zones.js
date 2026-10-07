// Zones: the searchable list. Tapping a zone opens its sheet.
import { $, $$, escape, html, icon, isPressed, pad } from '../core/dom.js';
import { app, context, render } from '../core/app.js';
import { clock, day, duration } from '../core/format.js';
import { filterZones, lastRuns, zoneMode } from '../model/zones.js';
import { openZone } from './zone-sheet.js';

const FILTERS = ['favorites', 'flagged', 'show-unused'];

/** Whether unused zones are shown; the Walk rail follows the same chip. */
export const showUnused = () => isPressed('show-unused');

function row(z, ctx, runs) {
  const mode = zoneMode(z, ctx),
    live = mode === 'running' || mode === 'unknown';
  const issue = z.issues?.at(-1),
    last = runs[z.id];
  const meta =
    mode === 'starting'
      ? 'Starting…'
      : mode === 'stopping'
        ? 'Stopping…'
        : live
          ? z.owned
            ? 'Watering'
            : 'Watering · started at the controller'
          : issue
            ? `<span class="issue">${escape(issue.issue)}</span> · flagged ${day(issue.at)}`
            : last
              ? `Last run ${day(last.at)} · ${duration(last.minutes)}`
              : escape((z.notes || '').split('\n')[0]);
  // Countdowns are filled in by tick() so the list's markup stays stable between polls.
  const end =
    mode === 'running'
      ? `<span class="zone-end" data-rem="${z.id}"></span>`
      : `<span class="zone-end">${icon('next')}</span>`;
  return `<button class="zone${live ? ' running' : ''}${mode === 'starting' || mode === 'stopping' ? ' pending' : ''}" data-zone="${z.id}" aria-label="${escape(z.name)}, zone ${z.id}${live ? ', watering' : ''}"><span class="zone-num">${pad(z.id)}</span><span class="zone-text"><span class="zone-name"><span>${escape(z.name)}</span>${z.favorite ? icon('star', 'fav') : ''}${z.issues?.length ? icon('flag') : ''}</span><span class="zone-meta">${meta}</span></span>${end}</button>`;
}

export function mount() {
  $('search').addEventListener('input', render);
  for (const id of FILTERS)
    $(id).addEventListener('click', () => {
      $(id).setAttribute('aria-pressed', String(!isPressed(id)));
      render();
    });
  $('zones').addEventListener('click', e => {
    const b = e.target.closest('[data-zone]');
    if (b) openZone(b.dataset.zone);
  });

  return {
    render() {
      const zones = filterZones(app.state.zones, {
        query: $('search').value,
        showUnused: showUnused(),
        favorites: isPressed('favorites'),
        flagged: isPressed('flagged'),
      });
      $('zone-count').textContent = `${zones.length} zones`;
      $('empty').hidden = zones.length > 0;
      $('zones').hidden = !zones.length;
      const ctx = context(),
        runs = lastRuns(app.state.events);
      html('zones', zones.map(z => row(z, ctx, runs)).join(''));
    },
    tick(now) {
      $$('[data-rem]').forEach(el => {
        const z = app.state.zones.find(z => z.id === el.dataset.rem);
        if (z?.endsAt) el.textContent = clock(Date.parse(z.endsAt) - now);
      });
    },
  };
}
