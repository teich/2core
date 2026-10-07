import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { DemoDriver } from '../server/demo.mjs';
import { createServer } from '../server/http.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
};
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), '2core-async-'));
  const file = join(dir, 'test.sqlite');
  const store = new Store(file),
    driver = new DemoDriver();
  const engine = new Engine({ store, driver });
  await engine.refresh();
  const server = createServer(engine, 'test-key');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await engine.queue;
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const headers = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json', Prefer: 'respond-async' };
  const request = (path, body, key = 'async-command') =>
    fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...headers, 'Idempotency-Key': key },
      body: body ? JSON.stringify({ ...body, deadline: new Date(Date.now() + 60000).toISOString() }) : undefined,
    });
  return { engine, driver, store, file, request };
}

test('HTTP accepts durably before Tucor responds and completes without a waiting client', async t => {
  const { engine, driver, file, request } = await fixture(t);
  const gate = deferred();
  t.after(() => gate.resolve());
  const withSession = driver.withSession.bind(driver);
  driver.withSession = async (...args) => {
    await gate.promise;
    return withSession(...args);
  };
  const response = await request('/zones/1/start', { minutes: 1 });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('location'), '/api/commands/async-command');
  assert.equal((await response.json()).operation.state, 'pending');
  const disk = new Store(file);
  assert.equal(disk.operation('async-command').state, 'pending');
  disk.close();
  assert.equal(driver.nextHandle, 1);
  // Neither a status poll nor a second POST is required to finish the work.
  gate.resolve();
  await engine.queue;
  const result = await (await request('/commands/async-command')).json();
  assert.equal(result.operation.state, 'succeeded');
  assert.equal(driver.nextHandle, 2);
});

test('duplicate accepted requests join the same operation; payload conflicts are rejected', async t => {
  const { engine, driver, request } = await fixture(t);
  const gate = deferred();
  const blocking = engine.serial(() => gate.promise);
  const first = await request('/zones/1/start', { minutes: 1 });
  const second = await request('/zones/1/start', { minutes: 1 });
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal((await request('/zones/1/start', { minutes: 5 })).status, 409);
  gate.resolve();
  await blocking;
  await engine.queue;
  assert.equal(driver.nextHandle, 2);
  const replay = await request('/zones/1/start', { minutes: 1 });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).operation.state, 'succeeded');
});

test('stop-and-next is a single accepted server operation', async t => {
  const { engine, driver, request } = await fixture(t);
  await engine.start('1', 1);
  const gate = deferred();
  const blocking = engine.serial(() => gate.promise);
  const response = await request('/zones/2/next', { minutes: 5 });
  assert.equal(response.status, 202);
  gate.resolve();
  await blocking;
  await engine.queue;
  assert.equal(driver.runs.length, 1);
  assert.equal(driver.runs[0].zone, '2');
  assert.equal((await (await request('/commands/async-command')).json()).operation.state, 'succeeded');
});

test('a failed stop prevents next from starting', async t => {
  const { engine, driver, request } = await fixture(t);
  await engine.start('1', 1);
  const original = driver.withSession.bind(driver);
  driver.withSession = fn =>
    original(s =>
      fn({
        ...s,
        stop: async () => {
          throw new Error('No stop confirmation');
        },
      }),
    );
  assert.equal((await request('/zones/2/next', { minutes: 1 })).status, 202);
  await engine.queue;
  assert.equal(driver.nextHandle, 2);
  assert.equal(driver.runs[0].zone, '1');
  assert.equal(engine.store.operation('async-command').state, 'failed');
});

test('accepted commands expire in the queue without touching the driver', async t => {
  const { engine, driver, store } = await fixture(t);
  let now = Date.now();
  engine.clock = () => now;
  const gate = deferred();
  const blocking = engine.serial(() => gate.promise);
  const { completion } = engine.submit(
    'queued-expiry',
    'start',
    {},
    () => engine.start('1', 1),
    new Date(now + 1000).toISOString(),
  );
  now += 2000;
  gate.resolve();
  await blocking;
  await assert.rejects(completion, /expired while queued/);
  assert.equal(driver.nextHandle, 1);
  assert.equal(store.operation('queued-expiry').state, 'failed');
});

test('restarting preserves inventory and pending outcomes, without replaying commands', async t => {
  const { engine, file } = await fixture(t);
  engine.store.acceptCommand(
    'interrupted-key',
    'fingerprint',
    '/api/zones/1/start',
    { minutes: 1 },
    new Date(Date.now() + 60000).toISOString(),
    new Date().toISOString(),
  );
  const secondStore = new Store(file);
  const secondDriver = new DemoDriver();
  const restarted = new Engine({ store: secondStore, driver: secondDriver });
  assert.equal(restarted.state().zones.length, 12);
  const operation = restarted.store.operation('interrupted-key');
  assert.equal(operation.state, 'failed');
  assert.match(operation.result.error, /restarted.*unknown/);
  assert.equal(secondDriver.nextHandle, 1);
  secondStore.close();
});

test('prepare is immediate and command status remains authenticated', async t => {
  const { engine, request } = await fixture(t);
  const gate = deferred();
  const blocking = engine.serial(() => gate.promise);
  assert.equal((await request('/prepare', {})).status, 202);
  const response = await request('/commands/missing-command');
  assert.equal(response.status, 404);
  assert.equal((await fetch(response.url)).status, 401);
  gate.resolve();
  await blocking;
  await engine.queue;
});
