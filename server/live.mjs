import io from 'socket.io-client';
import { setTimeout as sleep } from 'node:timers/promises';
import { ORIGIN, devicesFromResponse, summarize, plan } from '../lib/protocol.mjs';
import { trace } from './telemetry.mjs';

export class LiveDriver {
  constructor({ user, password, token, controllerId, socketFactory = io, logger = () => {}, clock = Date.now,
    idleMs = 90000, handoffMs = 1000, maxSessionMs = 600000, freshMs = 3000, waitMs = 20000 }) {
    Object.assign(this, { user, password, token, controllerId, socketFactory, logger, clock, idleMs, handoffMs, maxSessionMs, freshMs, waitMs });
    this.tail = Promise.resolve();
    this.session = null;
  }
  async request(path, body, auth = true) {
    const response = await fetch(new URL(path, ORIGIN), { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { ...(auth ? { Authorization: `bearer ${this.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`Tucor HTTP ${response.status}`);
    return response.json();
  }
  async authenticate(t = trace(this.logger)) {
    if (this.authRejected) throw new Error('Tucor rejected the configured login; update credentials and restart 2core');
    if (this.token) {
      const q = new URLSearchParams({ token: this.token, controllerID: 'null', typeName: 'null' });
      try { if ((await t.stage('token_validation', () => this.request(`/api/validate-token?${q}`, null, false))).validatetoken) return; } catch { /* obtain a fresh token before any control command */ }
    }
    if (!this.user || !this.password) throw new Error('Configure Tucor credentials or a valid token');
    const token = await t.stage('authentication', () => this.request('/api/get-token', { user: this.user, password: this.password }, false));
    if (typeof token !== 'string' || !token || token === 'ACCESS DENIED') {
      this.authRejected = true;
      throw new Error('Tucor authentication failed; update credentials and restart 2core');
    }
    this.token = token;
  }
  withSession(fn, options = {}) {
    // Also protect direct callers: there is one owner of the selected controller.
    const result = this.tail.then(() => this.useSession(fn, options));
    this.tail = result.catch(() => {});
    return result;
  }
  async useSession(fn, { interactive = true, forceFresh = false, telemetry = trace(this.logger), deadline } = {}) {
    clearTimeout(this.idleTimer);
    await this.closing;
    const started = performance.now();
    let s = this.session;
    if (s && (!s.healthy || this.clock() >= s.expiresAt)) { await this.close(); s = null; }
    telemetry.record('session_reuse', started, 'ok', { reused: Boolean(s) });
    try {
      if (!s) {
        await this.authenticate(telemetry);
        const devices = devicesFromResponse(await telemetry.stage('device_list', () => this.request('/api/authenticated/function/getdevicelistnew?controllerID=null&typeName=null')));
        const device = devices.find(d => String(d.id) === String(this.controllerId));
        if (!device) throw new Error('Controller not found in this account');
        if (device.busy) throw new Error('Controller busy; leave the Tucor website on Device List');
        s = new Session(this, device);
        this.session = s;
        await s.open(telemetry);
        await s.fresh(telemetry);
      } else {
        await s.fresh(telemetry, forceFresh);
      }
      s.telemetry = telemetry;
      s.deadline = deadline;
      if (interactive) s.keepUntil = this.clock() + this.idleMs;
      return await fn(s);
    } catch (e) {
      await this.close();
      throw e;
    } finally {
      if (this.session) {
        s.telemetry = null;
        s.deadline = null;
        if (interactive) s.keepUntil = this.clock() + this.idleMs;
        // Background reads never extend an interactive session's idle timeout.
        const idleAt = s.keepUntil || this.clock() + this.handoffMs;
        this.idleTimer = setTimeout(() => { this.close().catch(() => {}); }, Math.max(0, Math.min(idleAt, s.expiresAt) - this.clock()));
        this.idleTimer.unref?.();
      }
    }
  }
  async close() {
    clearTimeout(this.idleTimer);
    const s = this.session;
    this.session = null;
    if (s) this.closing = s.close();
    await this.closing;
  }
}

class Session {
  constructor(driver, device) {
    this.driver = driver;
    this.device = device;
    this.socket = driver.socketFactory(ORIGIN, { autoConnect: false, reconnection: false, timeout: 15000 });
    this.expiresAt = driver.clock() + driver.maxSessionMs;
    this.sequence = 0;
    this.events = [];
    this.waiters = new Set();
    this.components = new Map();
    this.observed = { controllerMode: null, rainShutDown: null, stations: null };
    this.socket.on('message', message => this.receive(message));
    this.socket.on('disconnect', () => this.fail(new Error('Tucor connection lost; command outcome may be unknown')));
  }
  get healthy() { return this.socket.connected && !this.failure; }
  fail(error) { this.failure = error; for (const check of [...this.waiters]) check(); }
  receive(m) {
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return; } }
    if (!m || typeof m !== 'object') return;
    if (m.category === 'server' && m.command === 'login' && m.data?.status === 'BAD') {
      this.fail(new Error('Tucor socket login rejected')); return;
    }
    const at = this.driver.clock();
    const previous = this.components.get(m.component);
    if (m.component === 'Stations' && Array.isArray(m.data)) {
      const stations = summarize([...(previous ? [previous] : []), m]).stations;
      this.components.set('Stations', { component: 'Stations', data: stations });
      this.observed.stations = at;
    } else if (['Main', 'Flow', 'ElectricFlow'].includes(m.component) && m.data && !Array.isArray(m.data)) {
      this.components.set('Main', { component: 'Main', data: { ...this.components.get('Main')?.data, ...m.data } });
      for (const field of ['controllerMode', 'rainShutDown']) if (Object.hasOwn(m.data, field)) this.observed[field] = at;
    }
    this.events.push({ sequence: ++this.sequence, message: m });
    if (this.events.length > 256) this.events.shift();
    for (const check of [...this.waiters]) check();
  }
  snapshot() {
    const state = summarize([...this.components.values()]);
    const times = Object.values(this.observed);
    const receivedAt = times.some(t => t === null) ? null : new Date(Math.min(...times)).toISOString();
    return { controller: this.device, ...state, receivedAt, observed: { ...this.observed } };
  }
  send(data, write = false) {
    if (!this.healthy) throw this.failure ?? new Error('Tucor connection lost; command was not sent');
    if (write) {
      if (this.deadline && this.driver.clock() > this.deadline) throw new Error('Command expired before sending; inspect status before a new request');
      if (this.driver.clock() >= this.expiresAt) throw new Error('Tucor session expired before sending; inspect status before a new request');
      this.telemetry?.onStage('sending');
      this.telemetry?.record('write_sent', this.telemetry.started, 'ok', { component:data.component, command:data.command });
    }
    this.socket.emit('message', data);
  }
  wait(predicate, label, from = 0) {
    return new Promise((resolve, reject) => {
      const finish = (error, value) => { clearTimeout(timer); this.waiters.delete(check); error ? reject(error) : resolve(value); };
      const check = () => {
        // Do not accept a buffered response from a failed connection.
        if (!this.healthy) return finish(this.failure ?? new Error('Tucor connection lost; command outcome may be unknown'));
        const found = this.events.find(e => e.sequence > from && predicate(e.message));
        if (found) finish(null, found.message);
      };
      const timer = setTimeout(() => finish(new Error(`No confirmation for ${label}; inspect controller before retrying`)), this.driver.waitMs);
      this.waiters.add(check);
      check();
    });
  }
  async open(t) {
    await t.stage('socket_connect', () => new Promise((resolve, reject) => {
      const done = error => {
        clearTimeout(timer);
        this.socket.off('connect', connected);
        this.socket.off('connect_error', failed);
        this.socket.off('connect_timeout', failed);
        error ? reject(error) : resolve();
      };
      const connected = () => done();
      const failed = () => done(new Error('Unable to connect to Tucor'));
      const timer = setTimeout(failed, 15000);
      this.socket.once('connect', connected);
      this.socket.once('connect_error', failed);
      this.socket.once('connect_timeout', failed);
      this.socket.open();
    }));
    this.send({ category: 'route', data: '/' });
    for (const component of ['App', 'Login']) for (const command of ['Created', 'Mounted']) this.send({ component, command });
    await t.stage('socket_login', async () => {
      const from = this.sequence;
      this.send({ category: 'server', command: 'login', data: { token: this.driver.token } });
      await this.wait(m => m.category === 'data' && m.data?.item === 'User', 'login', from);
    });
    await t.stage('controller_select', async () => {
      const from = this.sequence;
      this.send({ category: 'server', command: 'select', data: { type: 'device', item: this.device.id, typename: this.device.type.toLowerCase(), controllerType: this.device.type.toUpperCase() } });
      this.selected = true;
      await this.wait(m => m.category === 'server' && /^I01(?::|$)/.test(m.data?.code ?? ''), 'controller connection', from);
    });
    const from = this.sequence;
    this.send({ category: 'route', data: '/home' });
    for (const component of ['Header', 'Home']) for (const command of ['Created', 'Mounted']) this.send({ component, command });
    this.send({ component: 'Header', command: 'Refresh' });
    await this.status(t, from);
  }
  async status(t, from) {
    // Measure both from the request, including packets that arrive out of order.
    await Promise.all([
      t.stage('main_status', () => this.wait(m => m.component === 'Main', 'status', from)),
      t.stage('station_status', () => this.wait(m => m.component === 'Stations' && Array.isArray(m.data), 'station activity', from)),
    ]);
  }
  async fresh(t, force = false) {
    // Stations/AutoStatus selects the station-only stream. Opening the vendor
    // dashboard restores Main + Stations updates on an existing session.
    this.send({ component: 'Header', command: 'SetState', position: 'Up' });
    const times = Object.values(this.observed);
    if (!force && times.every(at => at !== null && this.driver.clock() - at <= this.driver.freshMs)) return;
    const from = this.sequence;
    this.send({ component: 'Header', command: 'Refresh' });
    await this.status(t, from);
    if (Object.values(this.observed).some(at => at === null || this.driver.clock() - at > this.driver.freshMs)) {
      throw new Error('Controller status is stale; nothing was sent');
    }
  }
  async steps(packets) {
    for (const p of packets) {
      if (p.waitMs) await sleep(p.waitMs);
      else this.send(p.data, ['Start', 'Stop'].includes(p.data.command));
    }
  }
  async start(zone, minutes) {
    const from = this.sequence;
    await this.steps(plan('zone-start', zone, minutes));
    const result = await this.telemetry.stage('start_confirmation', () => this.wait(m => m.component === 'Stations' && Array.isArray(m.data) && m.data.some(s => String(s.StId) === zone && s.runningEntries?.length), 'zone start', from));
    const entries = result.data.find(s => String(s.StId) === zone).runningEntries;
    const handles = entries.map(e => Number(e.handleID)).filter(Number.isSafeInteger);
    if (handles.length !== 1) throw new Error('Unexpected running handles; inspect controller before retrying');
    return { handle: handles[0] };
  }
  async stop(handles) {
    const from = this.sequence;
    this.send({ component: 'Stations', command: 'Stop', handleID: handles }, true);
    this.send({ component: 'Stations', command: 'AutoStatus', switch: 'on' });
    await this.telemetry.stage('stop_confirmation', () => this.wait(m => m.component === 'Stations' && Array.isArray(m.data) && !m.data.some(s => s.runningEntries?.some(e => handles.includes(Number(e.handleID)))), 'zone stop', from));
  }
  async rain(hours) {
    const from = this.sequence;
    await this.steps(hours ? plan('rain-start', hours) : plan('rain-stop'));
    this.send({ component: 'Header', command: 'SetState', position: 'Up' });
    this.send({ component: 'Header', command: 'Refresh' });
    await this.telemetry.stage('rain_confirmation', () => this.wait(m => m.component === 'Main' && (hours ? Number(m.data?.rainShutDown) > hours * 3600 - 120 : Number(m.data?.rainShutDown) === 0), 'rain delay', from));
  }
  async close() {
    const release = this.selected && this.socket.connected;
    if (release) this.socket.emit('message', { category: 'server', command: 'deselect', data: { type: 'device', item: this.device.id } });
    this.fail(new Error('Tucor session closed; inspect status before retrying'));
    if (release) await sleep(150);
    this.socket.close();
  }
}
