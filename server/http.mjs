import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readAsset } from './static.mjs';
import { AppError } from './engine.mjs';

const authorized = (header, key) => {
  const value = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${key}`);
  return value.length === expected.length && timingSafeEqual(value, expected);
};
// Only the private Unix listener may set trustedOrigin. TCP never trusts headers.
export function createServer(engine, apiKey, { trustedOrigin } = {}) {
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
      // Plan edits are local, idempotent replacements that never contact Tucor, so
      // they skip the command queue and answer immediately.
      const intent = path.match(/^\/api\/zones\/(\d+)\/intent$/);
      if (intent) return json(200, engine.intent(intent[1], payload));
      if (path === '/api/plan/edit-preview') return json(200, engine.planEditPreview(payload));
      if (path === '/api/plan/edit-apply') return json(200, engine.planEditApply(payload));
      if (path === '/api/plan/program-preview') return json(200, engine.programPreview(payload));
      if (path === '/api/plan/seasonal') return json(200, engine.seasonalAdjustment(payload));
      if (path === '/api/plan/rebalance-preview') return json(200, engine.rebalancePreview());
      if (path === '/api/plan/rebalance') return json(200, engine.rebalance(payload));
      if (path === '/api/plan') return json(200, engine.planSettings(payload));
      const zone = path.match(/^\/api\/zones\/(\d+)\/(start|stop|next|preferences)$/);
      let fn;
      if (zone) {
        const [, id, action] = zone;
        fn = () =>
          action === 'start'
            ? engine.start(id, payload.minutes)
            : action === 'stop'
              ? engine.stop(id)
              : action === 'next'
                ? engine.next(id, payload.minutes)
                : engine.preferences(id, payload);
      } else if (path === '/api/stop') fn = () => engine.stop();
      else if (path === '/api/rain') fn = () => engine.rain(payload.hours);
      else if (path === '/api/policy') fn = () => engine.configurePolicy(payload);
      else if (path === '/api/weather') fn = () => engine.weather(payload);
      else return json(404, { error: 'Unknown API route' });
      if (req.headers.prefer?.split(',').some(value => value.trim() === 'respond-async')) {
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
