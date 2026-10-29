# Installed live server

- Host: `root@192.168.2.6` (Proxmox LXC, x86_64)
- Application via Tailscale: https://2core.giraffe-gamma.ts.net/
- Direct LAN address: http://192.168.2.6:8787
- Project directory: `/opt/2core`
- Compose service: `two-core`
- SQLite volume: `2core_irrigation-data`
- Private credentials: `/opt/2core/secrets/`
- Web access key: `/opt/2core/secrets/api_key`
- Controller: 2479, LTD; 100 slots, 28 named zones.
- Live manual controls: enabled. Weather policy: observe.

The app is bound to the LXC's LAN address. Docker starts at boot; Compose's restart policy restarts the app automatically. Tailscale Serve supplies HTTPS within the tailnet. No public exposure was configured in this deployment.

## Tailscale Serve

Serve uses the private Unix listener, which implicitly authenticates tailnet users:

```sh
tailscale serve --bg unix:/opt/2core/tailscale-runtime/serve.sock
tailscale serve status
curl https://2core.giraffe-gamma.ts.net/healthz
```

Run these on the LXC. The HTTPS site skips the app access-key form. Direct LAN/API access still requires the existing key. Using just `tailscale serve --bg 8787` defaults to `127.0.0.1:8787`, where this installation does not listen. Serve's configuration is managed by Tailscale and survives application deployments. See [tailscale-auth.md](tailscale-auth.md) for the socket permissions, UI authentication contract, and rollback procedure.

## Updating this installation

Run `./tools/deploy.sh` from the development checkout. It tests, transfers source, backs up the current release and SQLite, rebuilds, restarts, and verifies health. See [deploy/README.md](README.md#production-updates-from-the-development-checkout) for the full update and rollback procedure.

## Operations

```sh
ssh root@192.168.2.6
cd /opt/2core
docker compose ps
docker compose logs --tail 50
```

Retrieve the access key locally in your terminal when signing into another device:

```sh
ssh root@192.168.2.6 'cat /opt/2core/secrets/api_key'
```

To correct or rotate Tucor credentials without changing the app key:

```sh
ssh -t root@192.168.2.6 'python3 /opt/2core/tools/configure-secrets.py --update'
ssh root@192.168.2.6 'cd /opt/2core && docker compose up -d --force-recreate'
```

The helper verifies credentials with Tucor before replacing files. Container recreation is required because Compose mounts the individual secret files. Rejected credentials stop further login attempts until the app restarts.

The nightly checks (`server/API.md`, “Nightly checks”) open two short read-only Tucor sessions a night and show their results in Activity → Watering checks. Set `NIGHT_CHECKS=false` in `/opt/2core/.env` and recreate the service to stop them.

Set `ALLOW_LIVE_CONTROL=false` in `/opt/2core/.env` and recreate the service to return to read-only mode. This does not cancel a running controller timer or an existing rain delay.

## Supervised program test

Writes program 1, which is off and has no days, then reads it back. See
`research/scheduling-plan.md` (“The supervised program test”) for what it
writes and why. Run it only with someone at the controller, not during a
deploy or a watering test.

1. Set `ALLOW_PROGRAM_WRITES=true` in `/opt/2core/.env`, then
   `docker compose up -d --force-recreate`. Check
   `GET /api/programs` reports `"writesEnabled": true`.
2. Open the app once so 2core has a fresh read of the programs.
3. Start the test (the key stays on the server):

   ```sh
   ssh root@192.168.2.6 'curl -sS -X POST http://192.168.2.6:8787/api/programs/test-write \
     -H "Authorization: Bearer $(cat /opt/2core/secrets/api_key)" \
     -H "Content-Type: application/json" -H "Prefer: respond-async" \
     -H "Idempotency-Key: program-test-$(date +%s)" \
     -d "{\"deadline\": \"$(date -u -d +100sec +%FT%TZ)\"}"'
   ```

   It answers at once with an operation; follow it at
   `/api/commands/<id>` (same headers, `GET`). The write takes about a
   minute and the sync can take a few more. The result's `outcome` is
   `synced` when it's done; `not synced` means Tucor's sync would have
   touched more than programs, so nothing was synchronized and `problems`
   says what. An error after sending started means the outcome is unknown:
   don't repeat it, look at program 1 first. Never finish a sync from
   Tucor's dialog with the controller's values: that undoes the write.
4. Check program 1 on the controller itself and in Tucor's app: off, zone 2
   for one minute, a 23:00 start, two days.
5. Restore it the same way with `/api/programs/restore-test-slot`, and check
   again.
6. Set `ALLOW_PROGRAM_WRITES=false` and recreate the service.

Each run's record, including everything Tucor sent back, is in
`GET /api/programs` under `tests`.

## Installing the plan

Writes the saved plan into all ten programs, then syncs. In the app this is
Plan → More → Controller programs → Review install; the steps below do the
same from a terminal. Run it only with
someone watching, and with every Tucor tab and app closed: while Tucor's own
app holds the controller, 2core can't connect. Nothing may be running.

1. Set `ALLOW_PROGRAM_WRITES=true` in `/opt/2core/.env`, then
   `docker compose up -d --force-recreate`.
2. Open the app so 2core reads today's programs, then review the install:

   ```sh
   ssh root@192.168.2.6 'curl -sS -X POST http://192.168.2.6:8787/api/programs/install-preview \
     -H "Authorization: Bearer $(cat /opt/2core/secrets/api_key)" -H "Content-Type: application/json" -d "{}"'
   ```

   Check `status` is `ready`, read each slot's `changes`, and note the
   `token`. A review is only good the same day, for the same plan and programs.
3. Install it, in the background like the program test, with
   `-H "Prefer: respond-async"` and `-d "{\"token\": \"TOKEN\", \"deadline\": …}"`
   to `/api/programs/install`, then follow `/api/commands/<id>`. `synced` means
   done. `not synced` means the write is in Tucor's cloud but Tucor's sync
   would have touched more than programs; `problems` says what. Sync by hand
   only if the dialog lists Programs alone, from the app.
4. Check the controller against the review.
5. To undo it, `POST /api/programs/restore-before-install` the same way
   (newest backup unless `{"backup": "<time from installBackups>"}`).
6. Set `ALLOW_PROGRAM_WRITES=false` and recreate the service.

An error after sending started leaves the outcome unknown. Don't repeat it:
the record in `GET /api/programs` `tests` says how far each slot got.

## Renaming programs

`POST /api/programs/rename` with `{"names": {"1": "Big olives", …}, "deadline": …}`,
sent like the install (in the background, then follow `/api/commands/<id>`).
It needs `ALLOW_PROGRAM_WRITES=true`, checks the names before contacting
Tucor (12 plain characters at most), changes nothing but the names, and syncs.

## Deployment verification

Live authentication, inventory, and status reads succeeded from the LXC. The latency update is deployed as release `20260928T011349Z-21591` (2026-09-27 local time). The original pre-update recovery snapshot is `/opt/2core/backups/20260928T010853Z-21070`.

With the user's authorization, zone 02 (Rear Lawn) was requested for one minute through the asynchronous production API. The server returned 202 in 6 ms, dispatched Start on its existing session 2 ms after acceptance was recorded, and observed running handle 37 after 9.778 seconds. Subsequent fresh status confirmed automatic expiry: zone 02 stopped, ownership cleared, and no zones running. These are controller protocol observations, not a visual inspection of water flow. No live rain-delay change or explicit stop was sent in this validation.

Warm full-status reads measured 1.920–3.339 seconds during the checks; the final completion read took 2.487 seconds. These are individual measurements inside the deployed container, not percentile guarantees. The phone acknowledges acceptance independently of controller confirmation, and the live Tailscale page showed the confirmed run without requesting Tucor credentials. See `server/API.md` for pending-command/restart semantics and session timeouts.

Weather comes from the Tempest through WeatherFlow's API; see the main README's “Weather from your Tempest” section. Run `python3 /opt/2core/tools/configure-secrets.py --weatherflow` on the server; the token goes in `/opt/2core/secrets/weatherflow_token` and the station in `/opt/2core/.env`. The old `secrets/ha_token` file from the Home Assistant setup is no longer used and can be deleted.
