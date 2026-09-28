# Local API v1

Base path `/api`. Direct TCP/LAN endpoints require `Authorization: Bearer ACCESS_KEY`. The private Tailscale Serve Unix listener authenticates requests through its trusted transport; implicit POST requests must carry the configured HTTPS `Origin`. No CORS is enabled. Credentials for Tucor are never returned. `GET /healthz` is a separate unauthenticated process-liveness check, not proof of a controller connection.

`GET /api/auth` is public and reports `{authenticated, mode}` for the current request. Mode is `tailscale` on the trusted private listener and `key` on TCP. The UI uses this endpoint to skip its access-key form only for implicit Tailscale authentication; the server independently authorizes every API request. See `deploy/tailscale-auth.md`.

`GET /api/state` returns cached controller status, availability, zone inventory/run ownership, policy, the last weather decision, the latest 50 activity records, and up to 50 command operations (pending first). The last observation is persisted for quick inventory display after restart; its timestamp is never renewed just by reading it. `POST /api/refresh` with `{}` requests a fresh controller observation. Concurrent refreshes are coalesced and pending background refreshes yield to commands. Live background refresh runs once per minute. UI status polling reads only the cache every 1.5 seconds while visible; HA retains its existing polling behavior.

`POST /api/prepare` with `{}` immediately returns 202 and warms a controller session in the background. The web app calls it on opening/unlocking, not on each status poll. Interactive sessions are retained for 90 seconds after use, with a ten-minute maximum lifetime. Background refreshes never extend that idle timeout; background-only sessions are released after a one-second handoff window. A command arriving during refresh reuses its session. Warm sessions use receipt timestamps for controller mode, rain hold, and stations, requesting new observations when these are over three seconds old. A disconnected/failed session is discarded; writes are never automatically replayed.

Every mutation below requires `Content-Type: application/json`, a unique `Idempotency-Key` header (8–100 alphanumeric/hyphen/underscore characters), and an ISO `deadline` in the body no more than 120 seconds in the future. Clients use 60 seconds. The remaining properties are:

| POST path | Properties | Meaning |
| --- | --- | --- |
| `/api/zones/:id/start` | `minutes`: integer 1–60 | Single bounded run; rejects overlap, rain delay, non-Automatic mode |
| `/api/zones/:id/stop` | none | Stop recorded owned handle for this zone |
| `/api/zones/:id/next` | `minutes`: integer 1–60 | Confirm stop of owned runs, then check safety and start the target; one server-owned operation |
| `/api/stop` | none | Stop all recorded owned runs |
| `/api/zones/:id/preferences` | optional `name`, `notes`, `order`, `favorite` | Local metadata; does not change Tucor configuration |
| `/api/rain` | `hours`: integer 0–999 | Explicit manual hold replacement; 0 clears |
| `/api/policy` | any subset of policy fields below | Persist settings |
| `/api/weather` | `observedAt`, optional `intensityMmH`, `accumulationMm`, `forecastMm`, `forecastProbability` | Submit normalized weather observation |

Policy fields: `mode` (`off`, `observe`, `automatic`), `intensityMmH` (0.01–100), `accumulationMm` and `forecastMm` (0.1–500), `forecastProbability` (1–100), `holdHours` (integer 1–72).

By default mutations wait for confirmation and return their existing result, preserving HA/API compatibility. With `Prefer: respond-async`, the server commits the command to SQLite and immediately returns **202** with `{operation}` and a `Location: /api/commands/:id` header. Acceptance means the bridge will attempt the operation within its deadline; it does not mean the controller has acted. Execution continues independently of the HTTP connection or phone. Payload/safety failures appear in the operation's final result. `GET /api/commands/:id` (authenticated) returns `{operation}`: `id`, `kind`, `body`, `acceptedAt`, `deadline`, `phase`, `state` (`pending`, `succeeded`, `failed`), and `result`. The phase distinguishes queued, connecting, sending, and confirming. Terminal duplicate async requests return 200 with the recorded operation.

Successful duplicate keys with identical payloads return the recorded result without re-executing. Concurrent duplicates join the same operation. Reusing a key for different content fails. Failed requests cannot be replayed; commands pending at server restart become failed with an explicit unknown-outcome message and are **not resumed**. Accepted work survives closing the phone, not a server crash. A failed write can have an unknown physical outcome; refresh and inspect before deliberately making a new request. Keys and operation records are retained indefinitely. The UI remembers its last request ID and checks status after reopening or losing an acknowledgement; it never automatically sends it again.

`available` means the last successful controller observation is under three minutes old and no later connection error is recorded. `controlEnabled` is a separate server switch. Zone `endsAt` is an estimate for a confirmed owned run; the controller remains responsible for the timer. The UI keeps showing a run until a fresh observation confirms it stopped.

Typical errors: 400 invalid/expired request; 401 bad API key; 403 live controls disabled; 404 unknown route/zone; 409 conflicting/unsafe state or reused command; 503 connection failure or unconfirmed outcome. No automatic write retries. A successful response confirms an observed protocol state, not physical valve movement.
