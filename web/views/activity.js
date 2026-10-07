// Activity: controller readings, command history and Tucor connection limits.
import { $, escape, html } from '../core/dom.js';
import { app } from '../core/app.js';
import { ago } from '../core/format.js';
import { tucorNote } from '../model/connection.js';

const eventRow = e =>
  `<div class="event"><strong>${escape(e.kind.replace('/api/', '').replaceAll('/', ' · '))}</strong> · <span class="${e.data.outcome === 'failed' ? 'failure' : ''}">${escape(e.data.outcome)}</span><small>${new Date(e.at).toLocaleString()}${e.data.message ? ` · ${escape(e.data.message)}` : ''}</small></div>`;

const connectionRow = h =>
  `<div class="event"><span class="${h.ok ? '' : 'failure'}">${h.ok ? 'Connected' : escape(h.error)}</span><small>${new Date(h.at).toLocaleString()}${h.codes?.length ? ` · ${escape(h.codes.join(' '))}` : ''}</small></div>`;

export function mount() {
  return {
    render() {
      const { status, observedAt, events, connection: c } = app.state;
      $('voltage').textContent = status.voltageV == null ? '—' : `${status.voltageV} V`;
      $('current').textContent = status.current == null ? '—' : `${status.current} mA`;
      $('observed').textContent = observedAt ? ago(observedAt) : '—';
      $('tucor-group').hidden = !c?.limits;
      $('tucor-sessions').textContent = c?.limits ? `${c.sessionsLastHour} of ${c.limits.sessionsPerHour}` : '—';
      $('tucor-logins').textContent = c?.limits ? `${c.loginsToday} of ${c.limits.loginsPerDay}` : '—';
      $('tucor-note').textContent = tucorNote(c);
      html('tucor-history', (c?.history || []).map(connectionRow).join(''));
      html('activity', events.length ? events.map(eventRow).join('') : '<p class="muted">Nothing yet.</p>');
    },
  };
}
