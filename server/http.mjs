import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AppError } from './engine.mjs';

const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/water.js': ['water.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
const authorized = (header, key) => {
  const value = Buffer.from(header ?? ''); const expected = Buffer.from(`Bearer ${key}`);
  return value.length === expected.length && timingSafeEqual(value, expected);
};
STATIC['/auth.js'] = ['auth.js', 'text/javascript'];

// Only the private Unix listener may set trustedOrigin. TCP never trusts headers.
export function createServer(engine, apiKey, { trustedOrigin } = {}) {
  if (trustedOrigin && new URL(trustedOrigin).origin !== trustedOrigin) throw new Error('Trusted origin must be an exact origin without a trailing slash');
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const bearer = authorized(req.headers.authorization, apiKey);
      // Serve rewrites Host for Unix upstreams. Authentication comes from the
      // private listener, never from client-supplied HTTP headers.
      const implicit = Boolean(trustedOrigin);
      if (path === '/healthz' && req.method === 'GET') return json(200, { ok: true, mode: engine.mode });
      if (path === '/api/auth' && req.method === 'GET') return json(200, { authenticated: implicit || bearer, mode: implicit ? 'tailscale' : 'key' });
      if (!path.startsWith('/api/')) {
        const asset = STATIC[path];
        if (!asset || req.method !== 'GET') return json(404, { error: 'Not found' });
        const data = await readFile(fileURLToPath(new URL(`../web/${asset[0]}`, import.meta.url)));
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); return res.end(data);
      }
      if (!implicit && !bearer) return json(401, { error: 'Enter the 2core access key' });
      if (req.method === 'GET' && path === '/api/state') return json(200, engine.state());
      if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
      if (implicit && !bearer && req.headers.origin !== trustedOrigin) return json(403, { error: 'Same-origin request required for Tailscale commands' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: 'JSON required' });
      let text = '';
      for await (const chunk of req) { text += chunk; if (text.length > 16384) throw new AppError('Request too large', 413); }
      let body;
      try { body = JSON.parse(text); } catch { throw new AppError('Invalid JSON', 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('JSON object required', 400);
      if (path === '/api/refresh') { await engine.refresh(); return json(200, engine.state()); }
      const { deadline, ...payload } = body;
      const zone = path.match(/^\/api\/zones\/(\d+)\/(start|stop|preferences)$/);
      let fn;
      if (zone) {
        const [, id, action] = zone;
        fn = () => action === 'start' ? engine.start(id, payload.minutes) : action === 'stop' ? engine.stop(id) : engine.preferences(id, payload);
      } else if (path === '/api/stop') fn = () => engine.stop();
      else if (path === '/api/rain') fn = () => engine.rain(payload.hours);
      else if (path === '/api/policy') fn = () => engine.configurePolicy(payload);
      else if (path === '/api/weather') fn = () => engine.weather(payload);
      else return json(404, { error: 'Unknown API route' });
      const result = await engine.command(req.headers['idempotency-key'], path, payload, fn, deadline);
      json(200, result);
    } catch (e) { json(e.status ?? 503, { error: e.message }); }
  });
}
