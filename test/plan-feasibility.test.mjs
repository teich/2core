import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessPlan, verifiedAlternatives } from '../lib/plan-feasibility.mjs';
import { compilePrograms } from '../lib/program-compiler.mjs';
const snapshot = JSON.parse(readFileSync(new URL('./fixtures/program-intents.json', import.meta.url)));
const start = new Date(2026, 9, 6);
const input = { zones: snapshot.zones, before: snapshot.plan, after: snapshot.plan, seasonalZoneIds: ['15', '16'], start, sunriseAt: () => 431 };

test('a full ten-program seasonal plan still reports fits without pretending capacity is exhausted', () => {
  const report = assessPlan(input);
  assert.equal(report.status, 'fits');
  assert.equal(report.scenarios.find(s => s.id === 'seasonal-on').programs, 10);
  assert.equal(report.scenarios.find(s => s.id === 'seasonal-off').programs, 9);
});

test('a new weekly pattern fits now but fails vineyard-on; proposed date changes fit both', () => {
  const after = structuredClone(input.before);
  after.intents['1'] = { ...after.intents['1'], cadence: { every: 7 }, firstDue: '2026-10-06' };
  const args = { ...input, after }, report = assessPlan(args);
  assert.equal(report.status, 'needs-adjustment');
  assert.notEqual(report.scenarios.find(s => s.id === 'current').status, 'needs-adjustment');
  assert.equal(report.scenarios.find(s => s.id === 'seasonal-on').reason, 'patterns');
  const before = structuredClone(after);
  const alternatives = verifiedAlternatives({ ...args, editedZoneIds: ['1'], report });
  assert.ok(alternatives.length);
  for (const a of alternatives) {
    assert.deepEqual(Object.keys(a.adjustments.intents), ['1']);
    assert.deepEqual(Object.keys(a.adjustments.intents['1']), ['firstDue']);
    assert.match(a.description, /duration and frequency stay the same/);
    assert.ok(a.assessment.scenarios.every(s => s.status !== 'needs-adjustment'));
    const candidate = structuredClone(after); Object.assign(candidate.intents['1'], a.adjustments.intents['1']);
    assert.equal(compilePrograms({ zones: input.zones, ...candidate, start, sunriseAt: input.sunriseAt, enabledOverrides: { 15: true, 16: true } }).status, 'candidate');
  }
  assert.deepEqual(after, before);
});

test('new overlap is disclosed before saving even when all scenarios fit', () => {
  const after = structuredClone(input.before); after.intents['1'].seconds = 3600;
  const p = assessPlan({ ...input, after });
  assert.equal(p.status, 'consequence');
  assert.ok(p.scenarios.some(s => s.additionalOverlapSeconds > 0 && s.affectedNights > 0));
});

test('overnight capacity failures offer verified earlier/later windows, not fictional repairs', () => {
  const plan = { intents: { 1: { seconds: 10800, cadence: { every: 1 }, firstDue: '2026-10-06' } }, settings: { earliestStart: 1560, hardDeadline: 240, finishBeforeSunrise: 0, lanes: 1 } };
  const args = { zones: [{ id: '1', name: 'Long run' }], before: plan, after: plan, start, sunriseAt: () => 420, seasonalZoneIds: [] };
  const report = assessPlan(args);
  assert.equal(report.scenarios[0].reason, 'time');
  const alternatives = verifiedAlternatives({ ...args, editedZoneIds: ['1'], report });
  assert.ok(alternatives.some(a => a.adjustments.settings?.earliestStart === 1500));
  assert.ok(alternatives.some(a => a.adjustments.settings?.hardDeadline === 300));
  for (const a of alternatives) assert.ok(a.assessment.scenarios.every(s => s.status !== 'needs-adjustment'));
});

test('unsupported cadence suggestions disclose frequency and watering changes', () => {
  const after = structuredClone(input.before); after.intents['1'].cadence = { every: 3 };
  const args = { ...input, after }, report = assessPlan(args);
  assert.equal(report.scenarios[0].reason, 'cadence');
  const alternatives = verifiedAlternatives({ ...args, editedZoneIds: ['1'], report });
  assert.ok(alternatives.length);
  assert.ok(alternatives.every(a => /watering minutes\/week/.test(a.description) && a.assessment.status !== 'needs-adjustment'));
});

test('repairing an uncompiled plan does not invent an overlap increase from an unknown baseline', () => {
  const before = structuredClone(input.before); before.intents['1'].cadence = { every: 3 };
  const report = assessPlan({ ...input, before });
  const seasonal = report.scenarios.find(s => s.id === 'seasonal-on');
  assert.equal(seasonal.comparable, false);
  assert.equal(seasonal.additionalOverlapSeconds, 0);
  assert.ok(seasonal.newParallelSeconds > 0);
});
