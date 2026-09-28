import { mkdir, readFile, unlink, chmod } from 'node:fs/promises';
import { Store } from './store.mjs';
import { DemoDriver } from './demo.mjs';
import { LiveDriver } from './live.mjs';
import { Engine } from './engine.mjs';
import { createServer } from './http.mjs';

const secret = async name => {
  if (!process.env[`${name}_FILE`]) return process.env[name];
  const value = await readFile(process.env[`${name}_FILE`], 'utf8');
  // Preserve intentional password whitespace; remove only the file's final newline.
  return name === 'TUCOR_PASSWORD' ? value.replace(/\r?\n$/, '') : value.trim();
};
const mode = process.env.MODE ?? 'demo';
if (!['live', 'demo'].includes(mode)) throw new Error('MODE must be live or demo');
const apiKey = await secret('API_KEY') || (mode === 'demo' ? '2core-demo' : '');
if (mode === 'live' && apiKey.length < 32) throw new Error('Set API_KEY or API_KEY_FILE to a random secret of at least 32 characters');
const dir = process.env.DATA_DIR ?? `./data/${mode}`;
await mkdir(dir, { recursive: true, mode: 0o700 });
const store = new Store(`${dir}/2core.sqlite`);
const logger = record => console.log(JSON.stringify(record));
const driver = mode === 'demo' ? new DemoDriver() : new LiveDriver({ user: await secret('TUCOR_USER'), password: await secret('TUCOR_PASSWORD'), token: await secret('TUCOR_TOKEN'), controllerId: process.env.CONTROLLER_ID ?? '2479', logger });
const engine = new Engine({ driver, store, mode, logger, allowControl: process.env.ALLOW_LIVE_CONTROL === 'true' });
const server = createServer(engine, apiKey);
const tailscaleSocket = process.env.TAILSCALE_SOCKET;
const tailscaleOrigin = process.env.TAILSCALE_ORIGIN;
if (Boolean(tailscaleSocket) !== Boolean(tailscaleOrigin)) throw new Error('TAILSCALE_SOCKET and TAILSCALE_ORIGIN must be set together');
if (tailscaleOrigin && new URL(tailscaleOrigin).protocol !== 'https:') throw new Error('TAILSCALE_ORIGIN must use HTTPS');
const tailscaleServer = tailscaleSocket ? createServer(engine, apiKey, { trustedOrigin: tailscaleOrigin }) : null;
await engine.refresh().catch(() => {});
let polling = false;
const timer = setInterval(async () => {
  if (polling) return;
  polling = true;
  try { await engine.refresh(); } catch { /* exposed as unavailable in state */ }
  finally { polling = false; }
}, mode === 'demo' ? 2000 : 60000);
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
server.listen(port, host, () => console.log(`2core ${mode} listening on http://${host}:${port}; live control ${engine.allowControl && mode === 'live' ? 'enabled' : 'disabled'}`));
if (tailscaleServer) {
  await unlink(tailscaleSocket).catch(e => { if (e.code !== 'ENOENT') throw e; });
  await new Promise((resolve, reject) => { tailscaleServer.once('error', reject); tailscaleServer.listen(tailscaleSocket, resolve); });
  await chmod(tailscaleSocket, 0o600);
  console.log('Private Tailscale Serve listener ready');
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  clearInterval(timer);
  await Promise.all([server, tailscaleServer].filter(Boolean).map(listener => new Promise(resolve => listener.close(resolve))));
  await engine.queue;
  await driver.close?.();
  store.close();
  process.exit(0);
});
