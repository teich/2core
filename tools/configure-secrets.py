#!/usr/bin/env python3
"""Validate and save Tucor credentials or the WeatherFlow token directly on the Docker host."""
import argparse
from getpass import getpass
import json
from pathlib import Path
import os
import secrets
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--update', action='store_true', help='Replace Tucor credentials while preserving the 2core access key')
parser.add_argument('--weatherflow', action='store_true', help='Save a WeatherFlow (Tempest) access token and choose the station')
args = parser.parse_args()
folder = Path(__file__).resolve().parents[1] / 'secrets'
folder.mkdir(mode=0o700, exist_ok=True)
folder.chmod(0o700)


def save(path, value):
    temporary = path.with_suffix('.new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    with os.fdopen(fd, 'w') as stream:
        stream.write(value + '\n' if value else '')
    # The private parent directory protects host access; Compose bind-mounts
    # each file separately for the non-root container process.
    temporary.chmod(0o444)
    temporary.replace(path)


def env_settings(env):
    if not env.exists():
        return {}
    return dict(line.split('=', 1) for line in env.read_text().splitlines() if '=' in line and not line.lstrip().startswith('#'))


def update_env(env, values):
    """Replace or append KEY=value lines, keeping every other line and comment."""
    lines, seen = (env.read_text().splitlines() if env.exists() else []), set()
    for i, line in enumerate(lines):
        key = line.split('=', 1)[0].strip()
        if key in values and not line.lstrip().startswith('#'):
            lines[i] = f'{key}={values[key]}'
            seen.add(key)
    lines += [f'{key}={value}' for key, value in values.items() if key not in seen]
    temporary = env.with_suffix('.new')
    temporary.write_text('\n'.join(lines) + '\n')
    temporary.chmod(0o600)
    temporary.replace(env)


def weatherflow_stations(token):
    # WeatherFlow takes the token as a query parameter.
    url = 'https://swd.weatherflow.com/swd/rest/stations?' + urllib.parse.urlencode({'token': token})
    with urllib.request.urlopen(url, timeout=20) as response:
        return json.load(response).get('stations') or []


def choose_station(stations, current):
    print('\nTempest stations on this account:')
    for number, station in enumerate(stations, 1):
        serials = ', '.join(d.get('serial_number', '') for d in station.get('devices', []) if d.get('device_type') == 'ST')
        marker = '  (current)' if str(station['station_id']) == current else ''
        print(f"  {number}) {station.get('name') or 'Unnamed'}  (station {station['station_id']}{f', Tempest {serials}' if serials else ''}){marker}")
    default = next((str(i) for i, s in enumerate(stations, 1) if str(s['station_id']) == current), '1' if len(stations) == 1 else '')
    while True:
        answer = input(f"  Number{f' [{default}]' if default else ''}: ").strip() or default
        if answer.isdigit() and 1 <= int(answer) <= len(stations):
            return str(stations[int(answer) - 1]['station_id'])
        print('  Enter one of the numbers shown.')


if args.weatherflow:
    env = Path(__file__).resolve().parents[1] / '.env'
    print('Create a token at tempestwx.com: Settings -> Data Authorizations -> Create Token.')
    token = getpass('WeatherFlow access token (hidden): ').strip()
    try:
        stations = weatherflow_stations(token)
    except Exception:
        raise SystemExit('WeatherFlow did not accept that token. No files changed.')
    if not stations:
        raise SystemExit('That WeatherFlow account has no stations. No files changed.')
    station = choose_station(stations, env_settings(env).get('WEATHERFLOW_STATION_ID', '').strip())
    save(folder / 'weatherflow_token', token)
    update_env(env, {'WEATHERFLOW_STATION_ID': station})
    print(f'\nToken saved to secrets/weatherflow_token and WEATHERFLOW_STATION_ID={station} to .env.')
    print('Restart the app with: docker compose -p 2core up -d --force-recreate')
    raise SystemExit(0)

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
    save(paths[name], value)
if not (folder / 'weatherflow_token').exists():
    # Compose requires the file; an empty token leaves weather reads off.
    save(folder / 'weatherflow_token', '')
print('Tucor login verified and saved. The web access key is in secrets/api_key.')
print('Restart the app with: docker compose up -d --force-recreate')
