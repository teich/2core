// The nightly checks as text for the Activity view. Pure; the server's
// lib/night-checks.mjs decides each night's status.

/** A night minute (minutes after the evening's midnight; 1530 is 1:30 AM) as `1:30 AM`. */
export const nightClock = minute => {
  const m = Math.round(minute) % 1440;
  return new Date(2000, 0, 1, Math.floor(m / 60), m % 60).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
};

const TONES = {
  'seen running': 'ok',
  ready: 'ok',
  'held by rain': 'rain',
  'nothing planned': '',
  'ready, not seen running': '',
  'not checked': '',
  waiting: '',
};

/** `Tonight`, `Last night`, or a short weekday and date for an evening `YYYY-MM-DD`. */
export function nightTitle(night, tonight) {
  if (night === tonight) return 'Tonight';
  const [y, m, d] = night.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const [ty, tm, td] = tonight.split('-').map(Number);
  if (Math.round((new Date(ty, tm - 1, td).getTime() - date.getTime()) / 864e5) === 1) return 'Last night';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * One row per night: `{ title, status, tone, detail }`. `tone` is a pill class.
 * @param {any} n A night from `state.nights.nights`.
 */
export function nightDetail(n) {
  const parts = [];
  if (n.zones) parts.push(`${n.zones} zone${n.zones === 1 ? '' : 's'}, ${nightClock(n.start)}–${nightClock(n.finish)}`);
  if (n.eveningAt != null) parts.push(`checks at ${nightClock(n.eveningAt)}`);
  if (n.evening && !n.evening.ok) parts.push(`couldn’t check: ${n.evening.error}`);
  for (const f of n.evening?.findings ?? []) if (f.warn || f.code === 'rain') parts.push(f.message);
  if (n.spot) parts.push(n.spot.message);
  else if (n.target && n.status === 'ready')
    parts.push(`looks for zone ${n.target.zone} at ${nightClock(n.target.at)}`);
  return parts.join(' · ');
}

/** @param {any} summary `state.nights` @param {string} tonight */
export function nightRows(summary, tonight) {
  return (summary?.nights ?? []).map(n => ({
    title: nightTitle(n.night, tonight),
    status: n.status,
    tone: n.warn ? 'bad' : (TONES[n.status] ?? ''),
    detail: nightDetail(n),
  }));
}

/** The controller-against-plan line: `[text, tone]`. */
export function syncLine(sync) {
  if (!sync) return ['Not checked yet', ''];
  const tone = { matches: 'ok', 'plan changed': 'warn', 'controller changed': 'bad' }[sync.state] ?? '';
  return [sync.message, tone];
}
