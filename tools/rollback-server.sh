#!/usr/bin/env bash
# Run on the LXC. Restore application source/config/image; keep current SQLite.
set -euo pipefail
release_id="${1:?Pass the recovery snapshot ID printed during deployment}"
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || exit 1
cd /opt/2core
backup="/opt/2core/backups/$release_id"
[[ -s "$backup/source.tgz" && -s "$backup/image-id" && -s "$backup/environment" ]] || exit 1
# An update invoking rollback already owns fd 9. Manual rollback acquires it.
if ! { true >&9; } 2>/dev/null; then
  exec 9>/opt/2core/.deploy.lock
  flock -n 9 || { echo 'Another deployment is in progress' >&2; exit 1; }
fi
docker compose -p 2core stop two-core
# Remove only deployable source directories to avoid leftovers from a newer release.
# Secrets, .env, backups, and the Docker data volume are outside these directories.
for directory in lib server web custom_components deploy tools; do
  if [[ -d "$directory" ]]; then mv "$directory" "$backup/failed-$directory-$(date +%s)-$$"; fi
done
tar -xzf "$backup/source.tgz" -C /opt/2core
cp "$backup/environment" .env
chmod 600 .env
docker tag "$(cat "$backup/image-id")" 2core-two-core:latest
docker compose -p 2core up -d --no-build --wait --wait-timeout 150
printf 'rollback:%s\n' "$release_id" > deployed-release
echo "Prior application restored from $backup. Current SQLite and credentials preserved."
