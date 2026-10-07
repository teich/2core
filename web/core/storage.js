// Per-browser conveniences in localStorage. Storage can be missing or throw
// (private mode, blocked site data), so every access falls back quietly; nothing
// here may be needed for correctness: the server is the source of truth.

export const readNumber = (name, fallback) => {
  try {
    return Number(localStorage.getItem(name)) || fallback;
  } catch {
    return fallback;
  }
};

export const readJSON = (name, fallback = null) => {
  try {
    return JSON.parse(localStorage.getItem(name) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
};

/** Stores a value; `null` or `undefined` removes it. Objects are stored as JSON. */
export const write = (name, value) => {
  try {
    if (value == null) localStorage.removeItem(name);
    else localStorage.setItem(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
  } catch {
    /* convenience only */
  }
};
