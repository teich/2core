import { mkdir, readFile, unlink, chmod } from 'node:fs/promises';
import { Store } from './store.mjs';
import { DemoDriver } from './demo.mjs';
import { LiveDriver } from './live.mjs';
import { Engine } from './engine.mjs';
import { createServer } from './http.mjs';
import { WeatherFlow } from './weatherflow.mjs';

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
const weatherflowToken = await secret('WEATHERFLOW_TOKEN');
if (weatherflowToken) {
  weather = new WeatherFlow({ token: weatherflowToken, stationId: process.env.WEATHERFLOW_STATION_ID || undefined });
} else if (mode === 'demo') {
  // Simulated station so the Weather tab can be seen without a WeatherFlow account.
  weather = { describe: () => ({ configured: true, source: 'Simulator', station: { id: 'demo', name: 'Garden simulator' } }),
    sample: async () => ({ intensityMmH: 0.1, accumulationMm: 1.4, forecastMm: 2.2, forecastProbability: 40, unit: 'in', observedAt: new Date().toISOString() }) };
}
engine.weatherSource = weather;
if (weather) {
  let checking = false;
  const check = async () => {
    // Weather mode off means no WeatherFlow requests either.
    if (checking || engine.store.get('policy')?.mode === 'off') return;
    checking = true;
    try {
      let sample;
      try { sample = await weather.sample(); }
      catch (e) { engine.recordWeatherRead({ error: e.message }); throw e; }
      if (!sample) { engine.recordWeatherRead({ error: 'No fresh rain readings from the station' }); return; }
      engine.recordWeatherRead({ sample });
      await engine.observeWeather(sample); // records its own failures
    } catch (e) {
      logger({ event: 'weather_error', message: e.message });
    } finally { checking = false; }
  };
  timers.push(setInterval(check, Number(process.env.WEATHER_INTERVAL_MS) || 300000));
  setTimeout(check, mode === 'demo' ? 1000 : 10000).unref();
}
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
