// Per-zone preferences kept on the bridge: alias, notes, favorite, walking
// order and flagged problems. Local only; they never reach Tucor.
import { AppError, LIMITS, number } from './validation.mjs';

const ISSUE_TEXT = 40;

/**
 * Validates a preferences patch and returns the merged preferences.
 * @param {Record<string, any>} previous The zone's saved preferences.
 * @param {Record<string, any>} body The patch from POST /api/zones/:id/preferences.
 */
export function mergePreferences(previous, body) {
  const next = { ...previous };
  for (const k of ['name', 'notes'])
    if (body[k] !== undefined) {
      if (typeof body[k] !== 'string' || body[k].length > (k === 'name' ? 80 : 1000))
        throw new AppError('Invalid zone text', 400);
      next[k] = body[k];
    }
  if (body.favorite !== undefined) {
    if (typeof body.favorite !== 'boolean') throw new AppError('Invalid favorite', 400);
    next.favorite = body.favorite;
  }
  if (body.order !== undefined) next.order = number(body.order, 0, 1000, true);
  if (body.issues !== undefined) {
    // Problems spotted on a walk: short labels with the time they were flagged.
    if (!Array.isArray(body.issues) || body.issues.length > LIMITS.issues)
      throw new AppError(`Expected up to ${LIMITS.issues} issues`, 400);
    next.issues = body.issues.map(item => {
      if (
        !item ||
        typeof item.issue !== 'string' ||
        !item.issue.trim() ||
        item.issue.length > ISSUE_TEXT ||
        !Number.isFinite(Date.parse(item.at))
      )
        throw new AppError('Invalid issue', 400);
      return { issue: item.issue.trim(), at: new Date(item.at).toISOString() };
    });
  }
  return next;
}
