import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cadencePerWeek, compareWatering, programPerWeek } from '../lib/program-compare.mjs';

const days = mask => [...mask].map(c => c !== '-');
const program = fields => ({
  id: '1',
  name: 'P',
  active: true,
  budget: 100,
  period: '14 days',
  days: days('-M-W-F--M-W-F-'),
  starts: [{ minute: 240, cycles: 1, finish: null }],
  steps: [],
  ...fields,
});

test('waterings per week come from the 14-day mask, odd/even days, or the plan cadence', () => {
  assert.equal(programPerWeek(program({ days: days('----T------T--') })), 1);
  assert.equal(programPerWeek(program({ days: days('--t-T--S--W--s') })), 2.5);
  assert.equal(programPerWeek(program({ period: 'Odd' })), 3.5);
  assert.equal(cadencePerWeek({ every: 2 }), 3.5);
  assert.equal(cadencePerWeek({ perWeek: 2 }), 2);
  assert.equal(cadencePerWeek(null), 0);
});

test('weekly time applies the program budget and adds up a zone across programs', () => {
  const programs = [
    program({ name: 'Even', period: 'Even', budget: 150, steps: [{ zone: '6', seconds: 1200 }] }),
    program({
      name: 'Weekly',
      days: days('----T------T--'),
      steps: [
        { zone: '6', seconds: 600 },
        { zone: '7', seconds: 300 },
      ],
    }),
    program({ name: 'Off', active: false, steps: [{ zone: '8', seconds: 9999 }] }),
  ];
  const intents = {
    6: { enabled: true, seconds: 1800, seasonalPercent: 100, cadence: { every: 2 } },
    7: { enabled: false, seconds: 300, cadence: { every: 1 } },
    9: { enabled: true, seconds: 600, seasonalPercent: 50, cadence: { perWeek: 2 } },
  };
  const { zones, totals } = compareWatering({ programs, intents, zones: [{ id: '6', name: 'Patio lower' }] });
  assert.deepEqual(
    zones.map(z => z.id),
    ['6', '7', '9'],
  );
  const [patio, seven, nine] = zones;
  assert.equal(patio.name, 'Patio lower');
  assert.deepEqual(patio.controller.runs, [
    { program: 'Even', seconds: 1800, perWeek: 3.5 },
    { program: 'Weekly', seconds: 600, perWeek: 1 },
  ]);
  assert.equal(patio.controller.weekly, 1800 * 3.5 + 600);
  assert.equal(patio.plan.weekly, 1800 * 3.5);
  assert.ok(patio.change < 0);
  assert.equal(seven.plan, null, 'a paused zone has no plan');
  assert.equal(seven.change, -1);
  assert.deepEqual(nine.plan, { seconds: 300, perWeek: 2, weekly: 600 });
  assert.equal(nine.change, null, 'only the plan waters it');
  assert.equal(totals.controller, 1800 * 3.5 + 600 + 300);
  assert.equal(totals.plan, 1800 * 3.5 + 600);
});
