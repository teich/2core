#!/usr/bin/env python3
"""Validate and save Tucor credentials directly on the Docker host."""
import argparse
from getpass import getpass
import json
from pathlib import Path
import os
import secrets
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--update', action='store_true', help='Replace Tucor credentials while preserving the 2core access key')
args = parser.parse_args()
folder = Path(__file__).resolve().parents[1] / 'secrets'
folder.mkdir(mode=0o700, exist_ok=True)
folder.chmod(0o700)
paths = {name: folder / name for name in ('api_key', 'tucor_user', 'tucor_password')}
if any(path.exists() for path in paths.values()) and not args.update:
    raise SystemExit('Secret files already exist. Use --update to replace Tucor credentials and keep the access key.')
old_user = paths['tucor_user'].read_text().strip() if paths['tucor_user'].exists() else ''
user = getpass('Tucor username (hidden; blank keeps existing): ').strip() or old_user
password = getpass('Tucor password (hidden): ')
if not user or not password:
    raise SystemExit('Username and password are required. No files changed.')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

request = urllib.request.Request('https://tucor.mysrc.online/api/get-token',
    data=json.dumps({'user': user, 'password': password}).encode(),
    headers={'Content-Type': 'application/json'}, method='POST')
try:
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
        token = json.load(response)
except Exception:
    raise SystemExit('Unable to validate with Tucor. No credentials saved; check connectivity and try again.')
if not isinstance(token, str) or not token or token == 'ACCESS DENIED':
    raise SystemExit('Tucor rejected that login. No files changed. Check the password and run again.')

values = {'tucor_user': user, 'tucor_password': password}
if not paths['api_key'].exists():
    values['api_key'] = secrets.token_urlsafe(36)
for name, value in values.items():
    path = paths[name]
    temporary = path.with_suffix('.new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    with os.fdopen(fd, 'w') as stream:
        stream.write(value + '\n')
    # The private parent directory protects host access; Compose bind-mounts
    # each file separately for the non-root container process.
    temporary.chmod(0o444)
    temporary.replace(path)
print('Tucor login verified and saved. The web/HA access key is in secrets/api_key.')
print('Restart the app with: docker compose up -d --force-recreate')
