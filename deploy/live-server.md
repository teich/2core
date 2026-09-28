# Installed live server

- Host: `root@192.168.2.6` (Proxmox LXC, x86_64)
- Application via Tailscale: https://2core.giraffe-gamma.ts.net/
- Direct LAN address: http://192.168.2.6:8787
- Project directory: `/opt/2core`
- Compose service: `two-core`
- SQLite volume: `2core_irrigation-data`
- Private credentials: `/opt/2core/secrets/`
- Web/HA key: `/opt/2core/secrets/api_key`
- Controller: 2479, LTD; 100 slots, 28 named zones.
- Live manual controls: enabled. Weather policy: observe.

The app is bound to the LXC's LAN address. Docker starts at boot; Compose's restart policy restarts the app automatically. Tailscale Serve supplies HTTPS within the tailnet. No public exposure or HA installation was configured in this deployment.

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

Retrieve the access key locally in your terminal when signing into another device or configuring HA:

```sh
ssh root@192.168.2.6 'cat /opt/2core/secrets/api_key'
```

To correct or rotate Tucor credentials without changing the app key:

```sh
ssh -t root@192.168.2.6 'python3 /opt/2core/tools/configure-secrets.py --update'
ssh root@192.168.2.6 'cd /opt/2core && docker compose up -d --force-recreate'
```

The helper verifies credentials with Tucor before replacing files. Container recreation is required because Compose mounts the individual secret files. Rejected credentials stop further login attempts until the app restarts.

Set `ALLOW_LIVE_CONTROL=false` in `/opt/2core/.env` and recreate the service to return to read-only mode. This does not cancel a running controller timer or an existing rain delay.

## Deployment verification

Live authentication, inventory, and status reads succeeded from the LXC. The latency update is deployed as release `20260928T011349Z-21591` (2026-09-27 local time). The original pre-update recovery snapshot is `/opt/2core/backups/20260928T010853Z-21070`.

With the user's authorization, zone 02 (Rear Lawn) was requested for one minute through the asynchronous production API. The server returned 202 in 6 ms, dispatched Start on its existing session 2 ms after acceptance was recorded, and observed running handle 37 after 9.778 seconds. Subsequent fresh status confirmed automatic expiry: zone 02 stopped, ownership cleared, and no zones running. These are controller protocol observations, not a visual inspection of water flow. No live rain-delay change or explicit stop was sent in this validation.

Warm full-status reads measured 1.920–3.339 seconds during the checks; the final completion read took 2.487 seconds. These are individual measurements inside the deployed container, not percentile guarantees. The phone acknowledges acceptance independently of controller confirmation, and the live Tailscale page showed the confirmed run without requesting Tucor credentials. See `server/API.md` for pending-command/restart semantics and session timeouts.

For Home Assistant, copy `/opt/2core/custom_components/tucor_2core` into HA's `/config/custom_components/`, restart HA, then add **2core Irrigation** with the server URL and access key above. Tempest selections can wait.
