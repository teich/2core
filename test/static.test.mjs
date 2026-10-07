import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from '../server/http.mjs';
import { resolveAsset, serviceWorker, shellFiles } from '../server/static.mjs';

const engine = { mode: 'demo', state: () => ({}), refresh: async () => {} };

test('web and lib files resolve by path without a registry', () => {
  assert.match(resolveAsset('/').file, /web[/\\]index\.html$/);
  assert.match(resolveAsset('/main.js').type, /^text\/javascript/);
  assert.match(resolveAsset('/lib/planner.mjs').file, /lib[/\\]planner\.mjs$/);
  for (const path of [
    '/../package.json',
    '/lib/../server/http.mjs',
    '/.env',
    '/web/.hidden',
    '//app.js',
    '/app.js/',
    '/lib/x/y.mjs',
    '/README',
    '/a%2e%2e/b.js',
  ]) {
    assert.equal(resolveAsset(path), null, path);
  }
});

test('the service worker shell lists every asset and versions by content', async () => {
  const shell = await shellFiles();
  assert.equal(shell[0], '/');
  for (const path of ['/main.js', '/core/app.js', '/styles/base.css', '/manifest.webmanifest', '/lib/planner.mjs'])
    assert.ok(shell.includes(path), path);
  assert.ok(!shell.includes('/service-worker.js'));
  for (const path of shell) assert.ok(existsSync(resolveAsset(path).file), path);
  const source = await serviceWorker();
  assert.match(source, /const BUILD = \{"version":"[0-9a-f]{12}","shell":\["\/",/);
});

test('unknown and traversal paths are 404 over HTTP', async t => {
  const server = createServer(engine, 'test-key');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/lib/planner.mjs`)).status, 200);
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/main.js`, { method: 'HEAD' })).status, 404);
});
