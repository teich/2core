import { mkdir, readFile, unlink, chmod } from 'node:fs/promises';
import { Store } from './store.mjs';
import { DemoDriver } from './demo.mjs';
import { LiveDriver } from './live.mjs';
import { Engine } from './engine.mjs';
import { createServer } from './http.mjs';
import { HomeAssistantWeather } from './homeassistant.mjs';

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
const driver = mode === 'demo' ? new DemoDriver({ delayMs: Number(process.env.DEMO_DELAY_MS) || 0 }) : new LiveDriver({ user: await secret('TUCOR_USER'), password: await secret('TUCOR_PASSWORD'), token: await secret('TUCOR_TOKEN'), controllerId: process.env.CONTROLLER_ID ?? '2479', logger,
  // Connection limits and backoff persist, so restarts cannot reset them.
  ledger: { load: () => store.get('tucorGuard'), save: value => store.set('tucorGuard', value) } });
const engine = new Engine({ driver, store, mode, logger, allowControl: process.env.ALLOW_LIVE_CONTROL === 'true' });
const server = createServer(engine, apiKey);
const tailscaleSocket = process.env.TAILSCALE_SOCKET;
const tailscaleOrigin = process.env.TAILSCALE_ORIGIN;
if (Boolean(tailscaleSocket) !== Boolean(tailscaleOrigin)) throw new Error('TAILSCALE_SOCKET and TAILSCALE_ORIGIN must be set together');
if (tailscaleOrigin && new URL(tailscaleOrigin).protocol !== 'https:') throw new Error('TAILSCALE_ORIGIN must use HTTPS');
const tailscaleServer = tailscaleSocket ? createServer(engine, apiKey, { trustedOrigin: tailscaleOrigin }) : null;
// Live mode never polls Tucor in the background: the app's /api/prepare opens a session
// while someone is using it, and weather automation connects only to write a rain delay.
// The simulator refreshes itself so its runs visibly count down and expire.
const timers = [];
if (mode === 'demo') timers.push(setInterval(() => engine.refresh().catch(() => {}), 2000));

let weather = null;
if (process.env.HA_URL) {
  try {
    weather = new HomeAssistantWeather({ url: process.env.HA_URL, token: await secret('HA_TOKEN'), intensityEntity: process.env.HA_RAIN_RATE_ENTITY || undefined,
      accumulationEntity: process.env.HA_RAIN_TOTAL_ENTITY || undefined, forecastEntity: process.env.HA_FORECAST_ENTITY || undefined });
  } catch (e) {
    // A weather misconfiguration must not take down manual watering.
    engine.weatherSource = { configured: false, error: e.message };
    logger({ event: 'weather_error', message: e.message });
  }
}
if (weather) {
  engine.weatherSource = weather.describe();
  let checking = false;
  const check = async () => {
    // Weather mode off means no Home Assistant reads either.
    if (checking || engine.store.get('policy')?.mode === 'off') return;
    checking = true;
    try {
      let sample;
      try { sample = await weather.sample(); }
      catch (e) { engine.weatherUnavailable(`Can’t read Home Assistant: ${e.message}`); throw e; }
      if (sample) await engine.observeWeather(sample); // records its own failures
      else engine.weatherUnavailable('Home Assistant has no fresh rain readings');
    } catch (e) {
      logger({ event: 'weather_error', message: e.message });
    } finally { checking = false; }
  };
  timers.push(setInterval(check, Number(process.env.WEATHER_INTERVAL_MS) || 300000));
  setTimeout(check, 10000).unref();
} else engine.weatherSource ??= { configured: false };
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
  timers.forEach(clearInterval);
  await Promise.all([server, tailscaleServer].filter(Boolean).map(listener => new Promise(resolve => listener.close(resolve))));
  await engine.queue;
  await driver.close?.();
  store.close();
  process.exit(0);
});
