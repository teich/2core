// Text for times and durations. Pure: pass `now` to make results deterministic.

const DAY_MS = 864e5;
const midnight = d => new Date(new Date(d).toDateString()).getTime();

/** A countdown such as `4:05` or `1:02:09`. */
export const clock = ms => {
  const s = Math.max(0, Math.ceil(ms / 1000)),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/** A wall-clock time such as `9:41 PM`, in the viewer's locale. */
export const at = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** How long ago, such as `12 s ago` or `3 h ago`; a date once it is over a day. */
export const ago = (iso, now = Date.now()) => {
  const s = (now - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return 'never';
  if (s < 60) return `${Math.max(1, Math.round(s))} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/** `today`, `yesterday`, or a short date. */
export const day = (iso, now = Date.now()) => {
  const diff = Math.round((midnight(now) - midnight(iso)) / DAY_MS);
  return diff === 0
    ? 'today'
    : diff === 1
      ? 'yesterday'
      : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/** Minutes as `h:mm`. */
export const hm = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

/** Minutes as `45 min` or `1 h 30 min`. */
export const duration = m => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

/** Seconds remaining as `5 h` or `12 min`. */
export const hoursLeft = s => (s >= 3600 ? `${Math.round(s / 3600)} h` : `${Math.max(1, Math.ceil(s / 60))} min`);

/** A future time with its day when it is not today: `tomorrow 9:00 AM`, `Fri 6:00 PM`. */
export const whenAt = (ms, now = Date.now()) => {
  const days = Math.round((midnight(ms) - midnight(now)) / DAY_MS);
  return `${days === 0 ? '' : days === 1 ? 'tomorrow ' : `${new Date(ms).toLocaleDateString([], { weekday: 'short' })} `}${at(ms)}`;
};
