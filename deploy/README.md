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

The default binds to `127.0.0.1:8787`, suitable for an HTTPS reverse proxy on the same server. Set `BIND_ADDRESS` in `.env` to the server's LAN address if needed. Home Assistant must use the server's reachable address, **not its own localhost**. Put the phone app behind your existing HTTPS proxy, and use your existing VPN for remote access. The API key grants control when live writes are enabled; plain HTTP exposes it to the network. No public port forwarding is needed.

Docker runs as non-root with a read-only image; SQLite lives in the `irrigation-data` volume. Back up that volume and the private secrets directory. There must be **one bridge process per controller**. Do not scale replicas or run a second live instance.

Live mode starts **read-only**, regardless of any weather policy selection. It reads the controller about once per minute and releases the selection after each session. Browser/HA polls read the local cache. For controller troubleshooting or research, leave the vendor website on **Device List**. A busy controller or loss of connection makes 2core unavailable; it never forces another session off.

## Native Home Assistant 2026.09

1. Copy `custom_components/tucor_2core/` into `/config/custom_components/tucor_2core/` on HA and restart Home Assistant.
2. Under Settings → Devices & services → Add integration, search **2core Irrigation**.
3. Enter the 2core URL and the generated access key. HA stores its own access key in the config entry, never your Tucor password.
4. Verify the configured zone valves and status readings. A disabled valve for every unnamed slot is available in the entity registry if needed.
5. Keep **Weather mode = observe**. The integration's Configure options can be left without weather entities until you are ready.

Later, choose Tempest intensity and/or recent-rainfall sensors in Configure. Optionally choose a weather entity providing hourly precipitation and probability. The HA weather bridge checks those inputs every five minutes. No MQTT discovery, broker, or topic configuration is involved.

Use the web app for walking inspections, native entities/actions for HA dashboards and automations. Add the app to an iPhone home screen if useful; it has an app manifest. Commands require an active network connection, and the app intentionally does not cache or replay offline writes.

## Supervised first run

These steps remain to be performed with someone by the irrigation. They are not completed by the simulator tests.

1. Read current status and confirm zone names, no running zones, no rain hold, Automatic mode, and normal schedules. Do not use configuration synchronization.
2. Set `ALLOW_LIVE_CONTROL=true` in `.env`, then `docker compose up -d`. Enable only while validating; weather mode should still be **observe**.
3. Choose a safe zone and start **one minute**. Confirm water begins on the intended zone, a single running handle appears, and the timer expires without the phone or HA needing to stay open.
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

This deploys the **current working files**, including uncommitted changes; it does not pull from Git. The script runs the Node and HA tests first. If the test environment is missing, prepare it once:

```sh
npm ci
python3.14 -m venv .venv
.venv/bin/pip install -r requirements-test.txt
```

The update process:

1. Copies an explicit source bundle over SSH. Local secrets, `.env`, captures, SQLite data, and vendor research files are excluded.
2. Acquires a deployment lock and checks that the app reports no running zones.
3. Saves the previous application source, environment, private credentials, and Docker image reference in a timestamped, root-only `/opt/2core/backups/RELEASE_ID/` directory.
4. Replaces the deployable source directories and builds the new image while the old container remains running. The server's `.env` and credentials are preserved.
5. Stops the app briefly, snapshots its SQLite volume while the writer is stopped, and starts the new image. It never sends irrigation commands.
6. Waits for the container health check and reads authenticated controller status. It prints the release ID, backup path, zone count, and connectivity state.

Allow roughly 20–60 seconds of app downtime while the new process reconnects to Tucor. Controller schedules and any controller-owned timers continue independently. Avoid deployment during a watering test; the preflight check is based on the most recent controller observation, not a lock on the physical controller.

A build/start/health failure automatically restores the previous application and environment. A healthy app with an unavailable Tucor controller reports a separate failure for inspection; it does not automatically roll back because an external outage or busy controller is not evidence of a bad release.

### Manual rollback

Use the recovery snapshot ID printed by the update. Each snapshot is the **version before** that update:

```sh
ssh root@192.168.2.6 'ls -1 /opt/2core/backups'
ssh root@192.168.2.6 'bash /opt/2core/tools/rollback-server.sh RELEASE_ID'
```

Rollback restores application source, `.env`, and the prior Docker image, and waits for health. It preserves the current database and credentials. The failed source directories are moved into the backup directory for inspection. If the current rollback helper is damaged, run `/opt/2core/backups/RELEASE_ID/rollback.sh` instead.

The database snapshot is for disaster recovery, not automatic application rollback: restoring an older command ledger could forget previously issued watering commands. A future schema-breaking migration requires an explicit migration/rollback plan before using these scripts. Current releases use the same schema.

Do not run `docker compose down -v`: it deletes persistent preferences, ownership records, and command history. Keep several backup snapshots and their matching `2core-two-core:rollback-RELEASE_ID` image tags. Backups currently remain until manually retired. Store off-host copies privately because `secrets.tgz` contains credentials; same-host backups do not protect against loss of the LXC.

### Home Assistant integration updates

The Docker update also refreshes `/opt/2core/custom_components/tucor_2core`, but **does not install it on HA**. If those Python files changed, copy that directory over HA's existing `/config/custom_components/tucor_2core` and restart Home Assistant. Configuration entries and entity identifiers persist. Web/backend-only changes need no HA restart. Keep the API's `apiVersion` compatibility in mind when changing both sides.
