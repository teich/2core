// Boots the real server (server/index.mjs) in demo mode and drives the API the
// way the web app does: sign in, read state, run a zone, set a rain delay, edit
// the plan. Catches wiring mistakes that unit tests of single modules miss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer().once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });

test('the demo server serves the app and runs commands end to end', async t => {
  const dir = mkdtempSync(join(tmpdir(), '2core-smoke-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, MODE: 'demo', PORT: String(port), DATA_DIR: dir, WEATHERFLOW_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; !output.includes('listening'); i++) {
    if (i > 100 || child.exitCode != null) assert.fail(`server did not start:\n${output}`);
    await new Promise(r => setTimeout(r, 50));
  }

  const headers = { Authorization: 'Bearer 2core-demo' };
  const get = path => fetch(`${base}/api${path}`, { headers }).then(r => r.json());
  const post = (path, body, extra = {}) =>
    fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
        ...extra,
      },
      body: JSON.stringify({ ...body, deadline: new Date(Date.now() + 60000).toISOString() }),
    });
  /** Sends a command the way the app does (accepted at once) and waits for its outcome. */
  const command = async (path, body = {}) => {
    const accepted = await post(path, body, { Prefer: 'respond-async' });
    assert.ok([200, 202].includes(accepted.status), `${path} → ${accepted.status}`);
    let { operation } = await accepted.json();
    for (let i = 0; operation.state === 'pending' && i < 100; i++) {
      await new Promise(r => setTimeout(r, 50));
      ({ operation } = await get(`/commands/${operation.id}`));
    }
    assert.equal(operation.state, 'succeeded', `${path}: ${JSON.stringify(operation.result)}`);
    return operation;
  };

  // The shell and its assets.
  const page = await fetch(base).then(r => r.text());
  assert.match(page, /<script src="\/main.js" type="module">/);
  assert.match(await fetch(`${base}/service-worker.js`).then(r => r.text()), /"\/main.js"/);
  assert.equal((await fetch(`${base}/main.js`)).status, 200);
  assert.deepEqual(await fetch(`${base}/healthz`).then(r => r.json()), { ok: true, mode: 'demo' });

  // Sign-in.
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  await post('/prepare', {});
  let state = await get('/state');
  assert.equal(state.mode, 'demo');
  assert.equal(state.zones.length, 12);
  assert.ok(state.controlEnabled);

  // Run a zone, then stop it.
  const started = await command('/zones/3/start', { minutes: 5 });
  assert.equal(started.result.run.zone, '3');
  state = await get('/state');
  assert.deepEqual(
    state.zones.filter(z => z.running).map(z => [z.id, z.owned]),
    [['3', true]],
  );
  await command('/zones/3/stop');
  assert.equal((await get('/state')).zones.filter(z => z.running).length, 0);

  // Rain delay on and off; starting is refused while it is on.
  await command('/rain', { hours: 12 });
  assert.ok(Number((await get('/state')).status.rainShutDown) > 0);
  const refused = await post('/zones/1/start', { minutes: 1 });
  assert.equal(refused.status, 409);
  await command('/rain', { hours: 0 });

  // Preferences and the plan (local only).
  await command('/zones/2/preferences', { favorite: true, issues: [{ issue: 'Leak', at: new Date().toISOString() }] });
  const zone2 = (await get('/state')).zones.find(z => z.id === '2');
  assert.equal(zone2.favorite, true);
  assert.equal(zone2.issues[0].issue, 'Leak');
  const change = { intents: { 2: { seconds: 600, cadence: { every: 2 } } } };
  const review = await post('/plan/edit-preview', { change }).then(r => r.json());
  assert.ok(review.token);
  const saved = await post('/plan/edit-apply', { change, token: review.token, saveUnresolved: true });
  assert.equal(saved.status, 200);
  assert.equal((await get('/state')).plan.intents['2'].seconds, 600);
  assert.equal((await post('/nope', {})).status, 404);
});
