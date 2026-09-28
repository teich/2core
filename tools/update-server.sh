#!/usr/bin/env bash
# Invoked by deploy.sh on the production server. Fixed paths are deliberate.
set -euo pipefail
archive="${1:?Missing source archive}"
release_id="${2:?Missing release ID}"
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || exit 1
[[ "$archive" == "/tmp/2core-update-$release_id.tgz" ]] || exit 1
cd /opt/2core
exec 9>/opt/2core/.deploy.lock
flock -n 9 || { echo 'Another deployment is in progress' >&2; exit 1; }
compose=(docker compose -p 2core)
container_id="$("${compose[@]}" ps -q two-core)"
[[ -n "$container_id" ]] || { echo 'Start the existing installation before using the update script.' >&2; exit 1; }
# A software update never starts or stops an irrigation run. Defer while watering.
"${compose[@]}" exec -T two-core node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
const key=readFileSync('/run/secrets/api_key','utf8').trim();
const r=await fetch('http://127.0.0.1:8787/api/state',{headers:{Authorization:`Bearer ${key}`}});
if(!r.ok) throw new Error('Cannot inspect application state before deployment');
const s=await r.json();
if(s.zones?.some(z=>z.running)) {console.error('Watering is active. Deploy after it finishes.');process.exit(1);}
if(s.operations?.some(o=>o.state==='pending')) {console.error('A command is pending. Deploy after it finishes.');process.exit(1);}
JS
backup="/opt/2core/backups/$release_id"
mkdir -p "$backup"
chmod 700 /opt/2core/backups "$backup"
old_image="$(docker inspect --format '{{.Image}}' "$container_id")"
docker tag "$old_image" "2core-two-core:rollback-$release_id"
printf '%s\n' "$old_image" > "$backup/image-id"
tar --exclude='__pycache__' --exclude='._*' -czf "$backup/source.tgz" \
  Dockerfile .dockerignore package.json package-lock.json compose.yaml lib server web deploy README.md tools
cp .env "$backup/environment"
tar -czf "$backup/secrets.tgz" secrets
chmod 600 "$backup"/*
# Keep a known-good copy outside the source tree for failure recovery.
cp tools/rollback-server.sh "$backup/rollback.sh"
recover() {
  result=$?
  trap - ERR
  echo "Update failed. Restoring prior source/config/image from $backup" >&2
  bash "$backup/rollback.sh" "$release_id" || echo "Automatic rollback failed; inspect $backup and Docker logs." >&2
  exit "$result"
}
trap recover ERR
for directory in lib server web deploy tools; do
  mv "$directory" "$backup/source-before-$directory"
done
# The old Home Assistant integration is no longer deployed; keep its copy with this backup.
if [[ -d custom_components ]]; then mv custom_components "$backup/source-before-custom_components"; fi
tar -xzf "$archive" -C /opt/2core
# Compose requires every secret file. An empty WeatherFlow token leaves weather reads off.
if [[ ! -e secrets/weatherflow_token ]]; then install -m 444 /dev/null secrets/weatherflow_token; fi
"${compose[@]}" config --quiet
"${compose[@]}" build
"${compose[@]}" stop two-core
# Snapshot SQLite while the sole writer is stopped, including any WAL files.
docker run --rm --read-only --entrypoint tar -v 2core_irrigation-data:/data:ro \
  "$old_image" -czf - -C /data . > "$backup/data.tgz"
chmod 600 "$backup/data.tgz"
"${compose[@]}" up -d --no-build --wait --wait-timeout 150
trap - ERR
printf '%s\n' "$release_id" > /opt/2core/deployed-release
rm -f "$archive" "/tmp/2core-update-$release_id.sh"
echo "Deployed $release_id. Recovery snapshot: $backup"
"${compose[@]}" exec -T two-core node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
const key=readFileSync('/run/secrets/api_key','utf8').trim();
const r=await fetch('http://127.0.0.1:8787/api/state',{headers:{Authorization:`Bearer ${key}`}});
const s=await r.json();
// 2core no longer contacts Tucor on startup, so controller availability is not checked here.
console.log(JSON.stringify({http:r.status,mode:s.mode,controlEnabled:s.controlEnabled,configuredZones:s.zones?.filter(z=>z.configured).length,weatherMode:s.policy?.mode,weatherSource:s.weatherSource?.configured?`tempest ${s.weatherSource.station?.id??''}`.trim():'not configured',tucorSessionsLastHour:s.connection?.sessionsLastHour,tucorRetryAt:s.connection?.retryAt},null,2));
if(!r.ok) {console.error('App is deployed, but its API did not answer.');process.exit(2);}
JS
