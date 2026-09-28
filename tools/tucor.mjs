#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { ORIGIN, plan, devicesFromResponse, historyGroupFor, redact, summarize } from '../lib/protocol.mjs';

const [command, ...args] = process.argv.slice(2);
let token;
const secrets = [];
const print = value => console.log(JSON.stringify(redact(value, secrets), null, 2));

async function prompt(label, hidden = false) {
  if (!process.stdin.isTTY) throw new Error('Set TUCOR_TOKEN or TUCOR_USER and TUCOR_PASSWORD for noninteractive use');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!muted) process.stderr.write(chunk, encoding);
    callback();
  } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = rl.question(label);
    muted = hidden;
    return await answer;
  } finally {
    rl.close();
    if (hidden) process.stderr.write('\n');
  }
}

async function request(path, { authenticated = true, method = 'GET', body, timeout = 20000 } = {}) {
  // Fixed origin; do not forward credentials through redirects.
  const response = await fetch(new URL(path, ORIGIN), {
    method, redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: {
      ...(authenticated ? { Authorization: `bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`Tucor returned HTTP ${response.status}`);
  return response.json();
}

async function authenticate() {
  token = process.env.TUCOR_TOKEN;
  if (!token) {
    const user = process.env.TUCOR_USER || await prompt('Tucor username: ');
    const password = process.env.TUCOR_PASSWORD || await prompt('Tucor password: ', true);
    secrets.push(password);
    token = await request('/api/get-token', { authenticated: false, method: 'POST', body: { user, password } });
    if (typeof token !== 'string' || !token || token === 'ACCESS DENIED') throw new Error('Login failed');
  }
  secrets.push(token);
  const query = new URLSearchParams({ token, controllerID: 'null', typeName: 'null' });
  const validation = await request(`/api/validate-token?${query}`, { authenticated: false });
  if (!validation?.validatetoken) throw new Error('Token validation failed');
}

async function getDevices() {
  return devicesFromResponse(await request('/api/authenticated/function/getdevicelistnew?controllerID=null&typeName=null'));
}

function selectDevice(devices, id) {
  if (!id) throw new Error('Supply an explicit controller ID from the devices command');
  const device = devices.find(d => String(d.id) === String(id));
  if (!device) throw new Error('Controller ID is not in this account');
  return device;
}

async function createSocket() {
  const { default: io } = await import('socket.io-client');
  const socket = io(ORIGIN, { autoConnect: false, reconnection: false, timeout: 15000 });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', () => { socket.close(); reject(new Error('Socket.IO connection failed')); });
    socket.once('connect_timeout', () => { socket.close(); reject(new Error('Socket.IO connection timed out')); });
    socket.open();
  });
  return socket;
}

async function getStatus(device) {
  if (device.busy) throw new Error('Controller is busy. Leave its web interface for Device List before sampling');
  const socket = await createSocket();
  const messages = [];
  socket.on('message', message => messages.push(message));
  const send = message => socket.emit('message', message);
  async function waitFor(predicate, description, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (!messages.some(predicate)) {
      if (!socket.connected) throw new Error(`Disconnected while waiting for ${description}`);
      if (messages.some(m => m?.category === 'server' && m?.command === 'login' && m?.data?.status === 'BAD')) throw new Error('Socket login rejected');
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}; authenticated socket sequence remains experimental`);
      await sleep(100);
    }
  }
  let selected = false;
  try {
    send({ category: 'route', data: '/' });
    for (const component of ['App', 'Login']) {
      send({ component, command: 'Created' });
      send({ component, command: 'Mounted' });
    }
    send({ category: 'server', command: 'login', data: { token } });
    await waitFor(m => m?.category === 'data' && m?.data?.item === 'User' && m?.data?.record?.length, 'user dataset');
    send({ category: 'server', command: 'select', data: {
      type: 'device', item: device.id, typename: device.type.toLowerCase(), controllerType: device.type.toUpperCase(),
    } });
    selected = true;
    await waitFor(m => m?.category === 'server' && /^I01(?::|$)/.test(m?.data?.code ?? ''), 'controller connection');
    send({ category: 'route', data: '/home' });
    for (const component of ['Header', 'Home']) {
      send({ component, command: 'Created' });
      send({ component, command: 'Mounted' });
    }
    send({ component: 'Header', command: 'Refresh' });
    await waitFor(m => m?.component === 'Main', 'main status');
    // Main.decoderList is the full inventory. Stations can be an empty running list.
    await waitFor(m => m?.component === 'Stations' && Array.isArray(m.data), 'station activity snapshot');
    return { controller: device, ...summarize(messages) };
  } finally {
    if (selected && socket.connected) {
      send({ category: 'server', command: 'deselect', data: { type: 'device', item: device.id } });
      await sleep(150);
    }
    socket.close();
    if (process.env.TUCOR_CAPTURE) await writeFile(process.env.TUCOR_CAPTURE,
      JSON.stringify(redact(messages, secrets), null, 2), { mode: 0o600 });
  }
}

async function main() {
  if (command === 'plan') return print({ dryRun: true, steps: plan(...args) });
  if (command === 'probe') {
    const socket = await createSocket();
    try { print({ connected: socket.connected, transport: socket.io.engine.transport.name, engineIOProtocol: 3, authenticated: false }); }
    finally { socket.close(); }
    return;
  }
  if (!['devices', 'status', 'history', 'stations'].includes(command)) {
    console.log(`Usage:
  npm run tucor -- probe                         # unauthenticated transport check
  npm run tucor -- devices                       # login, list authorized controllers
  npm run tucor -- status CONTROLLER_ID           # read-only socket sample
  npm run tucor -- stations CONTROLLER_ID         # station metadata through HTTP
  npm run tucor -- history CONTROLLER_ID          # available history categories/options
  npm run tucor -- history CONTROLLER_ID KIND OPTION
  npm run tucor -- plan zone-start STATION MINUTES
  npm run tucor -- plan zone-stop RUNNING_HANDLE
  npm run tucor -- plan rain-start HOURS
  npm run tucor -- plan rain-stop

Credentials: prompted in a terminal, or TUCOR_TOKEN / TUCOR_USER + TUCOR_PASSWORD.
Plans only print messages. This tool cannot transmit irrigation commands.
Status temporarily selects the controller; first leave the web UI on Device List.`);
    return;
  }
  await authenticate();
  const devices = await getDevices();
  if (command === 'devices') return print(devices);
  const device = selectDevice(devices, args[0]);
  if (command === 'status') return print(await getStatus(device));
  const query = new URLSearchParams({ group: historyGroupFor(device.type), controllerID: String(device.id), typeName: device.type.toLowerCase() });
  if (command === 'stations') return print(await request(`/api/auth/decoders?${query}`));
  const menu = await request(`/api/history?${query}`);
  if (!args[1]) return print(menu);
  if (!Array.isArray(menu)) throw new Error('Unexpected history menu');
  const item = menu.find(item => item.value === args[1]);
  if (!item) throw new Error('Choose a KIND from the returned history menu');
  const options = item.options?.length ? item.options : [{ value: item.value }];
  const option = options.find(option => String(option.value) === String(args[2] ?? options[0].value));
  if (!option) throw new Error('Choose an OPTION from the returned history menu');
  print(await request(`/api/auth/history/${encodeURIComponent(item.value)}/${encodeURIComponent(option.value)}?${query}`, { timeout: 75000 }));
}

main().catch(error => { console.error(redact(error.message, secrets)); process.exitCode = 1; });
