// Small DOM helpers shared by every view.

/**
 * The element with this id. Typed loosely on purpose: views know which kind of
 * element each id is, and casting at every call site would only add noise.
 * @param {string} id
 * @returns {any}
 */
export const $ = id => document.getElementById(id);

/** @param {unknown} text */
export const escape = text =>
  String(text ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** An icon from the sprite in index.html. */
export const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/** Zone numbers always show two digits. */
export const pad = id => String(id).padStart(2, '0');

export const isPressed = id => $(id).getAttribute('aria-pressed') === 'true';

const rendered = new WeakMap();
/**
 * Replaces an element's markup only when it changed. Polling re-renders every
 * second or so, and must not detach a focused control when nothing changed.
 * @param {string} id
 * @param {string} value
 */
export function html(id, value) {
  const el = $(id);
  if (rendered.get(el) === value) return;
  const focused = el.contains(document.activeElement)
    ? /** @type {HTMLElement} */ (document.activeElement)?.dataset
    : null;
  const focusId = focused?.zone || focused?.walk;
  el.innerHTML = value;
  rendered.set(el, value);
  if (focusId)
    [...el.querySelectorAll('button')]
      .find(b => (b.dataset.zone || b.dataset.walk) === focusId)
      ?.focus({ preventScroll: true });
}

/**
 * Every element matching a selector, as an array; typed loosely like `$`.
 * @param {string} selector
 * @returns {any[]}
 */
export const $$ = selector => [...document.querySelectorAll(selector)];
