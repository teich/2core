# Deployment and first hardware validation

## Proxmox

Use an existing Docker-capable VM or LXC. 2core is a small single-process Node 24 service plus SQLite; a container with 512 MB–1 GB RAM is ample for this initial app. Copy this project to a private directory on that server. No Proxmox-specific agent is required.

From the repository root:

```sh
cp deploy/.env.example .env
python3 tools/configure-secrets.py
docker compose up --build -d
docker compose logs --tail 30
```

The setup script prompts privately for your existing Tucor credentials and generates a random 2core API key in `secrets/api_key`. It does not print credentials. Keep `secrets/` mode 0700: its files are readable by the non-root Docker process through Compose secret mounts. The image excludes credentials, research captures, and vendor assets.

The default binds to `127.0.0.1:8787`, suitable for an HTTPS reverse proxy on the same server. Set `BIND_ADDRESS` in `.env` to the server's LAN address if needed. Put the phone app behind your existing HTTPS proxy, and use your existing VPN for remote access. The API key grants control when live writes are enabled; plain HTTP exposes it to the network. No public port forwarding is needed.

Docker runs as non-root with a read-only image; SQLite lives in the `irrigation-data` volume. Back up that volume and the private secrets directory. There must be **one bridge process per controller**. Do not scale replicas or run a second live instance.

Live mode starts **read-only**, regardless of any weather policy selection. It never polls Tucor in the background, including at startup. Opening the app prepares a session; while someone keeps using it, the app renews that session once a minute and the session streams controller updates. Sessions are released 90 seconds after the last renewal (ten-minute maximum lifetime). Weather writes release the controller after a one-second handoff. Browser polls read only the local cache.

Every new Tucor session counts against a limit of 20 per hour, and password logins against 6 per day. The cached token is reused; a password login happens at startup's first connection or when Tucor rejects the token. After a failed connection, automatic contact (app opening, weather) backs off from 30 seconds up to 15 minutes; an explicit command can still retry within the hourly limit. These counters and the last 30 connection outcomes are stored in SQLite, so restarts cannot reset them and failures remain visible under Activity after a redeploy. For controller troubleshooting or research, leave the vendor website on **Device List**. A busy controller or loss of connection makes 2core unavailable; it never forces another session off.

The phone immediately acknowledges accepted commands, which continue on the bridge after locking or closing it. “Stop & run next” is one server operation. Acceptance is distinct from controller confirmation; reopen the app to see the outcome. A bridge restart marks unfinished commands as failed/unknown rather than replaying watering. JSON records in container stdout report Tucor server status codes (`event=tucor_server`, for example `I01` connected or `I20` session timeout) and timings (`event=tucor_timing`):  operation IDs, queue delay, authentication, device discovery, socket/controller setup, status, write dispatch, and confirmation. They exclude credentials, URLs, and raw packets.

## Weather from Home Assistant

Home Assistant needs no custom integration; 2core reads its entities over the REST API. See the main [README](../README.md#weather-from-home-assistant) for the `.env` settings and `python3 tools/configure-secrets.py --ha-token`. Keep **Weather mode = observe** until you have watched its decisions through a rain event.

Add the app to an iPhone home screen if useful; it has an app manifest. Commands require an active network connection, and the app intentionally does not cache or replay offline writes.

## Supervised first run

These steps remain to be performed with someone by the irrigation. They are not completed by the simulator tests.

1. Read current status and confirm zone names, no running zones, no rain hold, Automatic mode, and normal schedules. Do not use configuration synchronization.
2. Set `ALLOW_LIVE_CONTROL=true` in `.env`, then `docker compose up -d`. Enable only while validating; weather mode should still be **observe**.
3. Choose a safe zone and start **one minute**. Confirm water begins on the intended zone, a single running handle appears, and the timer expires without the phone needing to stay open.
4. Repeat a short run and use **Stop my watering**. Confirm the valve physically stops. Then validate “Stop & run next.”
5. Test a short rain delay while the system is idle. Confirm the displayed remaining time, scheduled irrigation suppression, and explicit clear behavior. The vendor protocol replaces holds by issuing Stop, waiting one second, then Start; a disconnection between these commands can leave the old hold cleared. Inspect status after any error.
6. Add Tempest inputs and observe proposed decisions through a rain event before selecting Automatic. If a command times out, inspect controller status before issuing a new request. The app never automatically resends an uncertain write.

The app prevents starting a test during a rain hold until that controller interaction has been validated. It also refuses starts while any zone is running and stops only handles it recorded itself. If a start was accepted by Tucor but its acknowledgement was lost, 2core may not own that run: use the vendor controller UI to inspect/stop it. External changes can race the latest status read; this is not a transactional API at the physical controller.

To return to read-only, set `ALLOW_LIVE_CONTROL=false` and recreate the service. This does not cancel a timer or hold already sent to the controller; stop/clear explicitly first when appropriate.

## Production updates from the development checkout

The installed server is **root@192.168.2.6**, with the app at **http://192.168.2.6:8787**. Its source/config live in `/opt/2core`. See [live-server.md](live-server.md) for the exact operational state and credentials locations.

After making changes here, run this from the project root:

```sh
./tools/deploy.sh
```

The default destination is `root@192.168.2.6`. To target a different already-provisioned installation, pass its SSH destination explicitly:

```sh
./tools/deploy.sh root@SERVER_IP
```

This deploys the **current working files**, including uncommitted changes; it does not pull from Git. The script runs the Node tests first (`npm ci` once if dependencies are missing).

The update process:

1. Copies an explicit source bundle over SSH. Local secrets, `.env`, captures, SQLite data, and vendor research files are excluded.
2. Acquires a deployment lock and checks that the app reports no running zones.
3. Saves the previous application source, environment, private credentials, and Docker image reference in a timestamped, root-only `/opt/2core/backups/RELEASE_ID/` directory.
4. Replaces the deployable source directories and builds the new image while the old container remains running. The server's `.env` and credentials are preserved.
5. Stops the app briefly, snapshots its SQLite volume while the writer is stopped, and starts the new image. It never sends irrigation commands.
6. Waits for the container health check and reads the app's authenticated state. It prints the release ID, backup path, zone count, weather source, and Tucor connection counters. It does not contact Tucor.

Allow roughly 20–60 seconds of app downtime. Controller schedules and any controller-owned timers continue independently. Avoid deployment during a watering test; the preflight check is based on the most recent controller observation, not a lock on the physical controller.

A build/start/health failure automatically restores the previous application and environment. Controller connectivity is checked the next time someone opens the app.

### Manual rollback

Use the recovery snapshot ID printed by the update. Each snapshot is the **version before** that update:

```sh
ssh root@192.168.2.6 'ls -1 /opt/2core/backups'
ssh root@192.168.2.6 'bash /opt/2core/tools/rollback-server.sh RELEASE_ID'
```

Rollback restores application source, `.env`, and the prior Docker image, and waits for health. It preserves the current database and credentials. The failed source directories are moved into the backup directory for inspection. If the current rollback helper is damaged, run `/opt/2core/backups/RELEASE_ID/rollback.sh` instead.

The database snapshot is for disaster recovery, not automatic application rollback: restoring an older command ledger could forget previously issued watering commands. A future schema-breaking migration requires an explicit migration/rollback plan before using these scripts. Current releases use the same schema.

Do not run `docker compose down -v`: it deletes persistent preferences, ownership records, and command history. Keep several backup snapshots and their matching `2core-two-core:rollback-RELEASE_ID` image tags. Backups currently remain until manually retired. Store off-host copies privately because `secrets.tgz` contains credentials; same-host backups do not protect against loss of the LXC.
