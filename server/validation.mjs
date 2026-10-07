// Errors that reach the HTTP client, input checks, and the bridge's hard limits.

/** An error whose message is safe to show the person; `status` is the HTTP status. */
export class AppError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

/** Returns `value` if it is a finite number in [min, max] (an integer when asked), else throws a 400. */
export function number(value, min, max, integer = false) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new AppError(`Expected ${integer ? 'integer' : 'number'} between ${min} and ${max}`, 400);
  return value;
}

/** Shared with the web app through GET /api/state (`limits`). */
export const LIMITS = Object.freeze({ minMinutes: 1, maxMinutes: 240, concurrentZones: 1, issues: 20 });

/** True for a plain JSON object (not null, not an array). */
export const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
