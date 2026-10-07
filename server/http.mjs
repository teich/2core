import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readAsset } from './static.mjs';
import { AppError } from './validation.mjs';

const authorized = (header, key) => {
  const value = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${key}`);
  return value.length === expected.length && timingSafeEqual(value, expected);
};
// POST routes besides /api/prepare and /api/refresh. `:zone` matches a zone number.
// See server/API.md for request and response bodies.

/** Plan edits are local, idempotent replacements that never contact Tucor, so they skip the command queue. */
const LOCAL = routes({
  '/api/zones/:zone/intent': (engine, payload, { zone }) => engine.intent(zone, payload),
  '/api/plan/edit-preview': (engine, payload) => engine.planEditPreview(payload),
  '/api/plan/edit-apply': (engine, payload) => engine.planEditApply(payload),
  '/api/plan/program-preview': (engine, payload) => engine.programPreview(payload),
  '/api/plan/seasonal': (engine, payload) => engine.seasonalAdjustment(payload),
  '/api/plan/rebalance-preview': engine => engine.rebalancePreview(),
  '/api/plan/rebalance': (engine, payload) => engine.rebalance(payload),
  '/api/plan': (engine, payload) => engine.planSettings(payload),
});

/**
 * Commands run one at a time through the engine's queue, need an Idempotency-Key
 * and a deadline, and are recorded as operations. Each returns the work to queue.
 */
const COMMANDS = routes({
  '/api/zones/:zone/start':
    (engine, payload, { zone }) =>
    () =>
      engine.start(zone, payload.minutes),
  '/api/zones/:zone/stop':
    (engine, _payload, { zone }) =>
    () =>
      engine.stop(zone),
  '/api/zones/:zone/next':
    (engine, payload, { zone }) =>
    () =>
      engine.next(zone, payload.minutes),
  '/api/zones/:zone/preferences':
    (engine, payload, { zone }) =>
    () =>
      engine.preferences(zone, payload),
  '/api/stop': engine => () => engine.stop(),
  '/api/rain': (engine, payload) => () => engine.rain(payload.hours),
  '/api/policy': (engine, payload) => () => engine.configurePolicy(payload),
  '/api/weather': (engine, payload) => () => engine.weather(payload),
});

function routes(table) {
  return Object.entries(table).map(([pattern, handler]) => ({
    pattern: new RegExp(`^${pattern.replace(':zone', '(?<zone>\\d+)')}$`),
    handler,
  }));
}
function match(table, path) {
  for (const { pattern, handler } of table) {
    const found = path.match(pattern);
    if (found) return { handler, params: found.groups ?? {} };
  }
  return null;
}

// Only the private Unix listener may set trustedOrigin. TCP never trusts headers.
export function createServer(engine, apiKey, { trustedOrigin = /** @type {string | undefined} */ (undefined) } = {}) {
  if (trustedOrigin && new URL(trustedOrigin).origin !== trustedOrigin)
    throw new Error('Trusted origin must be an exact origin without a trailing slash');
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const bearer = authorized(req.headers.authorization, apiKey);
      // Serve rewrites Host for Unix upstreams. Authentication comes from the
      // private listener, never from client-supplied HTTP headers.
      const implicit = Boolean(trustedOrigin);
      if (path === '/healthz' && req.method === 'GET') return json(200, { ok: true, mode: engine.mode });
      if (path === '/api/auth' && req.method === 'GET')
        return json(200, { authenticated: implicit || bearer, mode: implicit ? 'tailscale' : 'key' });
      if (!path.startsWith('/api/')) {
        const asset = req.method === 'GET' ? await readAsset(path) : null;
        if (!asset) return json(404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': asset.type });
        return res.end(asset.data);
      }
      if (!implicit && !bearer) return json(401, { error: 'Enter the 2core access key' });
      if (req.method === 'GET' && path === '/api/state') return json(200, engine.state());
      const operation = path.match(/^\/api\/commands\/([a-zA-Z0-9_-]{8,100})$/);
      if (req.method === 'GET' && operation) {
        const result = engine.store.operation(operation[1]);
        return result ? json(200, { operation: result }) : json(404, { error: 'Command not found' });
      }
      if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
      if (implicit && !bearer && req.headers.origin !== trustedOrigin)
        return json(403, { error: 'Same-origin request required for Tailscale commands' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
        return json(415, { error: 'JSON required' });
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 16384) throw new AppError('Request too large', 413);
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new AppError('Invalid JSON', 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('JSON object required', 400);
      if (path === '/api/prepare') return json(202, engine.prepare());
      if (path === '/api/refresh') {
        await engine.refresh();
        return json(200, engine.state());
      }
      const { deadline, ...payload } = body;
      const local = match(LOCAL, path);
      if (local) return json(200, local.handler(engine, payload, local.params));
      const command = match(COMMANDS, path);
      if (!command) return json(404, { error: 'Unknown API route' });
      const fn = command.handler(engine, payload, command.params);
      if (
        String(req.headers.prefer ?? '')
          .split(',')
          .some(value => value.trim() === 'respond-async')
      ) {
        const { operation } = engine.submit(req.headers['idempotency-key'], path, payload, fn, deadline);
        res.setHeader('Preference-Applied', 'respond-async');
        if (operation) res.setHeader('Location', `/api/commands/${operation.id}`);
        return json(operation?.state === 'pending' ? 202 : 200, { operation });
      }
      const result = await engine.command(req.headers['idempotency-key'], path, payload, fn, deadline);
      json(200, result);
    } catch (e) {
      json(e.status ?? 503, { error: e.message });
    }
  });
}
