import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveDriver } from '../server/live.mjs';

test('a rejected password is not retried by subsequent background refreshes', async () => {
  const driver = new LiveDriver({ user: 'example', password: 'bad', controllerId: 2479 });
  let calls = 0;
  driver.request = async () => {
    calls++;
    return 'ACCESS DENIED';
  };
  await assert.rejects(driver.authenticate(), /authentication failed/);
  await assert.rejects(driver.authenticate(), /update credentials and restart/);
  assert.equal(calls, 1);
});
