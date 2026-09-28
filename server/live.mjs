import io from 'socket.io-client';
import { setTimeout as sleep } from 'node:timers/promises';
import { ORIGIN, devicesFromResponse, summarize, plan } from '../lib/protocol.mjs';

export class LiveDriver {
  constructor({ user, password, token, controllerId }) { Object.assign(this, { user, password, token, controllerId }); }
  async request(path, body, auth = true) {
    const response = await fetch(new URL(path, ORIGIN), { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { ...(auth ? { Authorization: `bearer ${this.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`Tucor HTTP ${response.status}`);
    return response.json();
  }
  async authenticate() {
    if (this.authRejected) throw new Error('Tucor rejected the configured login; update credentials and restart 2core');
    if (this.token) {
      const q = new URLSearchParams({ token: this.token, controllerID: 'null', typeName: 'null' });
      try { if ((await this.request(`/api/validate-token?${q}`, null, false)).validatetoken) return; } catch { /* obtain a fresh token before any control command */ }
    }
    if (!this.user || !this.password) throw new Error('Configure Tucor credentials or a valid token');
    const token = await this.request('/api/get-token', { user: this.user, password: this.password }, false);
    if (typeof token !== 'string' || !token || token === 'ACCESS DENIED') {
      this.authRejected = true;
      throw new Error('Tucor authentication failed; update credentials and restart 2core');
    }
    this.token = token;
  }
  async withSession(fn) {
    await this.authenticate();
    const devices = devicesFromResponse(await this.request('/api/authenticated/function/getdevicelistnew?controllerID=null&typeName=null'));
    const device = devices.find(d => String(d.id) === String(this.controllerId));
    if (!device) throw new Error('Controller not found in this account');
    if (device.busy) throw new Error('Controller busy; leave the Tucor website on Device List');
    const socket = io(ORIGIN, { autoConnect: false, reconnection: false, timeout: 15000 });
    const messages = [];
    socket.on('message', m => { if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return; } } messages.push(m); });
    const send = data => {
      if (!socket.connected) throw new Error('Tucor connection lost; command was not sent');
      socket.emit('message', data);
    };
    const wait = async (predicate, label, from = 0) => {
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        const found = messages.slice(from).find(predicate);
        if (found) return found;
        if (!socket.connected) throw new Error('Tucor connection lost; command outcome may be unknown');
        if (messages.some(m => m.category === 'server' && m.command === 'login' && m.data?.status === 'BAD')) throw new Error('Tucor socket login rejected');
        await sleep(100);
      }
      throw new Error(`No confirmation for ${label}; inspect controller before retrying`);
    };
    const snapshot = () => ({ controller: device, ...summarize(messages) });
    const steps = async packets => { for (const p of packets) { if (p.waitMs) await sleep(p.waitMs); else send(p.data); } };
    let selected = false;
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', () => reject(new Error('Unable to connect to Tucor')));
        socket.once('connect_timeout', () => reject(new Error('Tucor connection timeout')));
        socket.open();
      });
      send({ category: 'route', data: '/' });
      for (const component of ['App', 'Login']) for (const command of ['Created', 'Mounted']) send({ component, command });
      send({ category: 'server', command: 'login', data: { token: this.token } });
      await wait(m => m.category === 'data' && m.data?.item === 'User', 'login');
      send({ category: 'server', command: 'select', data: { type: 'device', item: device.id, typename: device.type.toLowerCase(), controllerType: device.type.toUpperCase() } });
      selected = true;
      await wait(m => m.category === 'server' && /^I01(?::|$)/.test(m.data?.code ?? ''), 'controller connection');
      send({ category: 'route', data: '/home' });
      for (const component of ['Header', 'Home']) for (const command of ['Created', 'Mounted']) send({ component, command });
      send({ component: 'Header', command: 'Refresh' });
      await wait(m => m.component === 'Main', 'status');
      await wait(m => m.component === 'Stations' && Array.isArray(m.data), 'station activity');
      return await fn({
        snapshot,
        start: async (zone, minutes) => {
          const from = messages.length;
          await steps(plan('zone-start', zone, minutes));
          const result = await wait(m => m.component === 'Stations' && Array.isArray(m.data) && m.data.some(s => String(s.StId) === zone && s.runningEntries?.length), 'zone start', from);
          const entries = result.data.find(s => String(s.StId) === zone).runningEntries;
          const handles = entries.map(e => Number(e.handleID)).filter(Number.isSafeInteger);
          if (handles.length !== 1) throw new Error('Unexpected running handles; inspect controller before retrying');
          return { handle: handles[0] };
        },
        stop: async handles => {
          const from = messages.length;
          send({ component: 'Stations', command: 'Stop', handleID: handles });
          send({ component: 'Stations', command: 'AutoStatus', switch: 'on' });
          await wait(m => m.component === 'Stations' && Array.isArray(m.data) && !m.data.some(s => s.runningEntries?.some(e => handles.includes(Number(e.handleID)))), 'zone stop', from);
        },
        rain: async hours => {
          const from = messages.length;
          await steps(hours ? plan('rain-start', hours) : plan('rain-stop'));
          send({ component: 'Header', command: 'Refresh' });
          await wait(m => m.component === 'Main' && (hours ? Number(m.data?.rainShutDown) > hours * 3600 - 120 : Number(m.data?.rainShutDown) === 0), 'rain delay', from);
        },
      });
    } finally {
      if (selected && socket.connected) { send({ category: 'server', command: 'deselect', data: { type: 'device', item: device.id } }); await sleep(150); }
      socket.close();
    }
  }
}
