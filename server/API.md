# Local API v1

Base path `/api`. Direct TCP/LAN endpoints require `Authorization: Bearer ACCESS_KEY`. The private Tailscale Serve Unix listener authenticates requests through its trusted transport; implicit POST requests must carry the configured HTTPS `Origin`. No CORS is enabled. Credentials for Tucor are never returned. `GET /healthz` is a separate unauthenticated process-liveness check, not proof of a controller connection.

`GET /api/auth` is public and reports `{authenticated, mode}` for the current request. Mode is `tailscale` on the trusted private listener and `key` on TCP. The UI uses this endpoint to skip its access-key form only for implicit Tailscale authentication; the server independently authorizes every API request. See `deploy/tailscale-auth.md`.

`GET /api/state` returns cached controller status, availability, zone inventory/run ownership, policy, the last weather decision, and the latest 50 activity records. `POST /api/refresh` with `{}` requests a fresh controller session. Normal UI/HA polling reads the cache every five seconds; live background refresh runs once per minute.

Every mutation below requires `Content-Type: application/json`, a unique `Idempotency-Key` header (8–100 alphanumeric/hyphen/underscore characters), and an ISO `deadline` in the body no more than 120 seconds in the future. Clients use 60 seconds. The remaining properties are:

| POST path | Properties | Meaning |
| --- | --- | --- |
| `/api/zones/:id/start` | `minutes`: integer 1–60 | Single bounded run; rejects overlap, rain delay, non-Automatic mode |
| `/api/zones/:id/stop` | none | Stop recorded owned handle for this zone |
| `/api/stop` | none | Stop all recorded owned runs |
| `/api/zones/:id/preferences` | optional `name`, `notes`, `order`, `favorite` | Local metadata; does not change Tucor configuration |
| `/api/rain` | `hours`: integer 0–999 | Explicit manual hold replacement; 0 clears |
| `/api/policy` | any subset of policy fields below | Persist settings |
| `/api/weather` | `observedAt`, optional `intensityMmH`, `accumulationMm`, `forecastMm`, `forecastProbability` | Submit normalized weather observation |

Policy fields: `mode` (`off`, `observe`, `automatic`), `intensityMmH` (0.01–100), `accumulationMm` and `forecastMm` (0.1–500), `forecastProbability` (1–100), `holdHours` (integer 1–72).

Successful duplicate keys with identical payloads return the recorded result without re-executing. Reusing a key for different content fails. Failed/pending keys cannot be replayed, including after restart. A failed write can have an unknown physical outcome; refresh and inspect before deliberately making a new request. Keys are durable and currently retained indefinitely in SQLite to preserve this property.

`available` means the last successful controller observation is under three minutes old and no later connection error is recorded. `controlEnabled` is a separate server switch. Zone `endsAt` is an estimate for a confirmed owned run; the controller remains responsible for the timer. The UI keeps showing a run until a fresh observation confirms it stopped.

Typical errors: 400 invalid/expired request; 401 bad API key; 403 live controls disabled; 404 unknown route/zone; 409 conflicting/unsafe state or reused command; 503 connection failure or unconfirmed outcome. No automatic write retries. A successful response confirms an observed protocol state, not physical valve movement.
