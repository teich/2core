#!/usr/bin/env bash
# Run from any directory on the development machine.
set -euo pipefail
cd "$(dirname "$0")/.."
deploy_target="${1:-root@192.168.2.6}"
if [[ "$deploy_target" == -* || ! "$deploy_target" =~ ^[a-zA-Z0-9_.@:-]+$ ]]; then
  echo 'Invalid SSH destination' >&2; exit 1
fi
npm test
release_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
bundle_dir="$(mktemp -d /tmp/2core-deploy.XXXXXX)"
trap 'rm -rf "$bundle_dir"' EXIT
tar_options=()
if [[ "$(uname -s)" == Darwin ]]; then tar_options=(--no-xattrs --no-mac-metadata); fi
COPYFILE_DISABLE=1 tar "${tar_options[@]}" --exclude='__pycache__' --exclude='.DS_Store' --exclude='._*' -czf "$bundle_dir/source.tgz" \
  Dockerfile .dockerignore package.json package-lock.json compose.yaml lib server web \
  deploy README.md tools/configure-secrets.py tools/deploy.sh tools/update-server.sh tools/rollback-server.sh
scp -q "$bundle_dir/source.tgz" "$deploy_target:/tmp/2core-update-$release_id.tgz"
scp -q tools/update-server.sh "$deploy_target:/tmp/2core-update-$release_id.sh"
ssh "$deploy_target" "bash /tmp/2core-update-$release_id.sh /tmp/2core-update-$release_id.tgz $release_id"
