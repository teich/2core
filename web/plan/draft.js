// Staging, checking and saving plan edits. Edits that fit save straight away;
// anything else (extra overlap, later finishes, seasonal failures) waits in the
// review sheet until the person chooses.
import { $ } from '../core/dom.js';
import { api } from '../core/api.js';
import { message } from '../core/message.js';
import { blank, hasDraft, hooks, intents, plan, rememberDraft, settings } from './state.js';

/** Adds a zone's changed fields to the draft. */
export function stageIntent(id, patch) {
  plan.edit.intents ??= {};
  plan.edit.intents[id] = { ...plan.edit.intents[id], ...patch };
  plan.drafts.set(id, { ...blank(), ...intents()[id], ...patch });
  plan.review = null;
  plan.error = '';
  rememberDraft();
}

/** Stages night settings and checks them, saving if they fit. */
export async function saveSettings(patch) {
  if (plan.busy) return;
  plan.edit.settings = { ...plan.edit.settings, ...patch };
  rememberDraft();
  plan.settingsDraft = { ...settings(), ...patch };
  plan.review = null;
  await checkDraft(true);
}

/**
 * Saves the reviewed draft, optionally with one of the server's verified
 * alternatives, or as an unfinished plan that keeps its problem visible.
 */
export async function applyReviewed(alternativeId = null, saveUnresolved = false) {
  if (!plan.review) return;
  const reviewed = plan.review;
  plan.busy = true;
  plan.error = '';
  hooks.render();
  try {
    const result = await api('/plan/edit-apply', {
      change: reviewed.change,
      token: reviewed.token,
      alternativeId,
      saveUnresolved,
    });
    for (const [id, intent] of Object.entries(result.plan.intents)) plan.drafts.set(id, intent);
    plan.settingsDraft = result.plan.settings;
    // Turning zones on or off can leave the nights lopsided; offer a rebalance.
    if (Object.values(reviewed.change.intents ?? {}).some(p => Object.hasOwn(p, 'enabled')))
      $('rebalance-prompt').hidden = false;
    plan.edit = {};
    rememberDraft();
    plan.review = { ...reviewed, assessment: result.assessment, alternatives: [], plan: result.plan, change: {} };
    plan.seasonalEdited = false;
    if ($('plan-review-dialog').open) $('plan-review-dialog').close();
    message(
      saveUnresolved
        ? 'Saved as an unfinished plan. The issue is still shown.'
        : alternativeId
          ? 'Saved with the adjustment.'
          : 'Saved.',
    );
  } catch (e) {
    plan.error = `${e.message} Your change is kept. Check it again before saving.`;
    plan.review = null;
  } finally {
    plan.busy = false;
    hooks.render();
  }
}

/** Asks the server whether the draft (or, with no draft, the saved plan) fits. */
export async function checkDraft(autoSave = false) {
  if (plan.busy) return;
  plan.busy = true;
  plan.error = '';
  hooks.render();
  try {
    const change = structuredClone(plan.edit);
    const result = await api('/plan/edit-preview', { change });
    plan.review = { ...result, change };
    // Use the server's normalized dates (including cadence changes) in the draft.
    if (hasDraft()) {
      for (const [id, intent] of Object.entries(result.plan.intents)) plan.drafts.set(id, intent);
      plan.settingsDraft = result.plan.settings;
    }
    if (autoSave && hasDraft() && result.assessment.status === 'fits') await applyReviewed();
  } catch (e) {
    plan.error = `Couldn’t check the plan: ${e.message}. Your change is kept.`;
    plan.review = null;
  } finally {
    plan.busy = false;
    hooks.render();
  }
  if (autoSave && hasDraft()) hooks.openReview();
}

export function discardDraft() {
  plan.edit = {};
  rememberDraft();
  plan.drafts.clear();
  plan.settingsDraft = null;
  plan.review = null;
  plan.error = '';
  plan.seasonalEdited = false;
  if ($('plan-review-dialog').open) $('plan-review-dialog').close();
  checkDraft(false);
}
