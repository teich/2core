// The only place the web app talks to the server's /api. See server/API.md.
import { app } from './app.js';

export const uuid = () =>
  globalThis.crypto?.randomUUID ? crypto.randomUUID() : `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * GET when `body` is omitted, otherwise POST with an idempotency key and a
 * deadline. `async` asks the server to accept the command and answer at once
 * (202 + operation) instead of waiting for the controller.
 * @param {string} path Path under /api, such as `/state`.
 * @param {object} [body]
 * @param {{ id?: string, deadline?: string, async?: boolean }} [options]
 */
export async function api(path, body, options = {}) {
  const response = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${app.key}`,
      ...(body
        ? {
            'Content-Type': 'application/json',
            'Idempotency-Key': options.id || uuid(),
            ...(options.async ? { Prefer: 'respond-async' } : {}),
          }
        : {}),
    },
    body: body
      ? JSON.stringify({ ...body, deadline: options.deadline || new Date(Date.now() + 60000).toISOString() })
      : undefined,
    signal: AbortSignal.timeout(options.async ? 15000 : 90000),
    keepalive: Boolean(options.async),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: response.status });
  return data;
}
