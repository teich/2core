#!/usr/bin/env python3
"""Validate and save Tucor credentials or the Home Assistant token directly on the Docker host."""
import argparse
from getpass import getpass
import json
from pathlib import Path
import os
import secrets
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--update', action='store_true', help='Replace Tucor credentials while preserving the 2core access key')
parser.add_argument('--ha-token', action='store_true', help='Save a Home Assistant long-lived access token, then choose weather entities')
parser.add_argument('--ha-entities', action='store_true', help='Choose Home Assistant weather entities using the saved token')
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


ENV_KEYS = ('HA_RAIN_RATE_ENTITY', 'HA_RAIN_TOTAL_ENTITY', 'HA_FORECAST_ENTITY')
FORECAST_HOURLY = 2  # WeatherEntityFeature.FORECAST_HOURLY


def env_settings(env):
    if not env.exists():
        return {}
    return dict(line.split('=', 1) for line in env.read_text().splitlines() if '=' in line and not line.lstrip().startswith('#'))


def update_env(env, values):
    """Replace or append KEY=value lines, keeping every other line and comment."""
    lines, seen = env.read_text().splitlines(), set()
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


def ha_get(url, token, path):
    request = urllib.request.Request(url.rstrip('/') + path, headers={'Authorization': f'Bearer {token}'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def describe(state):
    attributes = state.get('attributes', {})
    name = attributes.get('friendly_name', '')
    unit = attributes.get('unit_of_measurement', '')
    detail = f"{state.get('state')} {unit}".strip()
    if attributes.get('state_class'):
        detail += f", state class {attributes['state_class']}"
    return f"{state['entity_id']}  ({name}: {detail})" if name else f"{state['entity_id']}  ({detail})"


def choose(title, hint, candidates, current):
    print(f'\n{title}')
    if hint:
        print(f'  {hint}')
    if not candidates:
        print('  No matching entities found.' + (f' Keeping {current}.' if current else ''))
        return current
    for number, state in enumerate(candidates, 1):
        marker = '  (current)' if state['entity_id'] == current else ''
        print(f'  {number}) {describe(state)}{marker}')
    default = next((str(i) for i, state in enumerate(candidates, 1) if state['entity_id'] == current), '1' if len(candidates) == 1 else '')
    while True:
        answer = input(f"  Number, or 0 for none{f' [{default}]' if default else ''}: ").strip() or default
        if answer == '0' or answer == '':
            return ''
        if answer.isdigit() and 1 <= int(answer) <= len(candidates):
            return candidates[int(answer) - 1]['entity_id']
        print('  Enter one of the numbers shown.')


def discover(env, url, token):
    """Offer rain sensors by device class and unit, then save the choices to .env."""
    try:
        states = ha_get(url, token, '/api/states')
    except Exception:
        raise SystemExit(f'Could not list entities from Home Assistant at {url}. .env unchanged.')
    def sensors(device_class, units):
        return sorted((s for s in states if s['entity_id'].startswith('sensor.')
            and s.get('attributes', {}).get('device_class') == device_class
            and s.get('attributes', {}).get('unit_of_measurement') in units), key=lambda s: s['entity_id'])
    weather = sorted((s for s in states if s['entity_id'].startswith('weather.')
        and int(s.get('attributes', {}).get('supported_features') or 0) & FORECAST_HOURLY), key=lambda s: s['entity_id'])
    current = env_settings(env)
    chosen = {
        'HA_RAIN_RATE_ENTITY': choose('Rain rate (intensity)', 'How hard it is raining right now.',
            sensors('precipitation_intensity', ('mm/h', 'in/h')), current.get('HA_RAIN_RATE_ENTITY', '').strip()),
        'HA_RAIN_TOTAL_ENTITY': choose('Recent rainfall total',
            'Choose rain today or over the last 24 hours. Not lifetime, yearly, or previous-minute amounts.',
            sensors('precipitation', ('mm', 'in')), current.get('HA_RAIN_TOTAL_ENTITY', '').strip()),
        'HA_FORECAST_ENTITY': choose('Hourly forecast (optional)', 'A weather entity that provides an hourly forecast.',
            weather, current.get('HA_FORECAST_ENTITY', '').strip()),
    }
    if not any(chosen.values()):
        raise SystemExit('\nNo weather entity chosen. .env unchanged.')
    update_env(env, chosen)
    print('\nSaved to .env:')
    for key, value in chosen.items():
        print(f'  {key}={value}')


if args.ha_token or args.ha_entities:
    env = Path(__file__).resolve().parents[1] / '.env'
    url = env_settings(env).get('HA_URL', '').strip()
    if not url:
        raise SystemExit('Set HA_URL in .env first. No files changed.')
    if args.ha_token:
        token = getpass('Home Assistant long-lived access token (hidden): ').strip()
        try:
            ha_get(url, token, '/api/')
        except Exception:
            raise SystemExit(f'Home Assistant at {url} did not accept that token. No files changed.')
        save(folder / 'ha_token', token)
        print('Home Assistant token verified and saved.')
    else:
        token_file = folder / 'ha_token'
        token = token_file.read_text().strip() if token_file.exists() else ''
        if not token:
            raise SystemExit('No saved Home Assistant token. Run with --ha-token first.')
    discover(env, url, token)
    print('Restart the app with: docker compose up -d --force-recreate')
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
if not (folder / 'ha_token').exists():
    # Compose requires the file; an empty token leaves weather reads off.
    save(folder / 'ha_token', '')
print('Tucor login verified and saved. The web access key is in secrets/api_key.')
print('Restart the app with: docker compose up -d --force-recreate')
