import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, summarize, redact, devicesFromResponse, groupFor, historyGroupFor } from '../lib/protocol.mjs';

test('rain replacement preserves vendor stop/wait/start sequence and hours conversion', () => {
  const steps = plan('rain-start', 24);
  assert.equal(steps[0].data.command, 'Stop');
  assert.equal(steps[1].waitMs, 1000);
  assert.equal(steps[2].data.runtime, 86400);
});
test('station start uses scalar StId and seconds; stop uses numeric running handle', () => {
  assert.deepEqual(plan('zone-start', '2', 5)[0].data, { component: 'Stations', command: 'Start', id: '2', time: 300 });
  assert.deepEqual(plan('zone-stop', '123')[0].data.handleID, [123]);
});
test('invalid or overly long durations fail before generating commands', () => {
  for (const duration of [0, -1, 0.5, 'NaN', 1080, '']) assert.throws(() => plan('zone-start', 2, duration));
  for (const hours of [0, 1000, -2, '']) assert.throws(() => plan('rain-start', hours));
  assert.throws(() => plan('zone-start', 101, 1));
});
test('station delta omits stopped stations and does not erase station metadata', () => {
  const original = {
    component: 'Stations',
    data: [
      { StId: '1', name: 'Pots', runningEntries: [{ handleID: '5' }], isRunning: true },
      { StId: '2', name: 'Lawn', runningEntries: [] },
    ],
  };
  const update = {
    component: 'Stations',
    data: [{ StId: '2', name: '', runningEntries: [{ handleID: '6' }], isRunning: true }],
  };
  const result = summarize([original, update, { component: 'Main', data: { voltage: '3490', current: '19' } }]);
  assert.equal(result.stations[0].isRunning, false);
  assert.deepEqual(result.stations[0].runningEntries, []);
  assert.equal(result.stations[1].name, 'Lawn');
  assert.equal(result.status.voltageV, 34.9);
  assert.equal(original.data[0].isRunning, true);
});
test('credentials are redacted recursively including echoed secrets and token URLs', () => {
  assert.deepEqual(
    redact({ password: 'p', nested: { Authorization: 'bearer abc', url: '/?token=abc&x=1', message: 'failed abc' } }, [
      'abc',
    ]),
    {
      password: '[REDACTED]',
      nested: { Authorization: '[REDACTED]', url: '/?token=[REDACTED]&x=1', message: 'failed [REDACTED]' },
    },
  );
});
test('idle running list does not imply an empty station inventory', () => {
  const main = { component: 'Main', data: { decoderList: [{ decid: '1', name: 'ST1', description: 'Pots' }] } };
  const known = summarize([{ component: 'Stations', data: [] }, main]);
  assert.equal(known.stations.length, 1);
  assert.equal(known.stations[0].name, 'Pots');
  assert.equal(known.stations[0].isRunning, false);
  assert.equal(summarize([main]).stations[0].isRunning, null);
});
test('device metadata handles busy flag and controller group', () => {
  assert.equal(
    devicesFromResponse({ getdevicelistnew: [{ devicelist: [{ ctrlid: 1, active: '0' }] }] })[0].busy,
    false,
  );
  assert.equal(groupFor('ltd'), 'LTD');
  assert.equal(groupFor('GRO-WHATEVER'), 'TWC');
  assert.equal(historyGroupFor('ltd'), 'rkx');
  assert.equal(historyGroupFor('twc'), 'twc');
  assert.throws(() => devicesFromResponse({}));
});
test('full Stations packets cannot replace friendly inventory names with ST labels', () => {
  const main = {
    component: 'Main',
    data: {
      decoderList: [
        { decid: '1', name: 'ST1', description: 'Deck pots' },
        { decid: '29', name: 'ST29', description: '' },
      ],
    },
  };
  const full = {
    component: 'Stations',
    data: [
      { StId: '1', name: 'ST1', isRunning: false, runningEntries: [] },
      { StId: '29', name: 'ST29', isRunning: false, runningEntries: [] },
    ],
  };
  for (const packets of [
    [main, full],
    [full, main],
  ]) {
    const stations = summarize(packets).stations;
    assert.equal(stations[0].name, 'Deck pots');
    assert.equal(stations[1].name, '');
    assert.equal(stations[1].label, 'ST29');
  }
});
