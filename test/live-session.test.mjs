import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { LiveDriver } from '../server/live.mjs';
import { Engine } from '../server/engine.mjs';
import { Store } from '../server/store.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class Cloud {
  constructor() { this.sockets = []; this.sent = []; this.runs = []; this.handle = 0; this.http = []; this.main = { controllerMode: 2, rainShutDown: 0, decoderList: [1, 2].map(decid => ({ decid, name: `ST${decid}`, description: `Garden ${decid}` })) }; }
  factory = () => {
    const cloud = this;
    const socket = new class extends EventEmitter {
      stationOnly = cloud.stickyStationOnly;
      open() { this.connected = true; super.emit('connect'); }
      close() { this.connected = false; super.emit('disconnect'); }
      receive(message) { super.emit('message', structuredClone(message)); }
      emit(event, data) {
        if (event !== 'message') return super.emit(event, data);
        cloud.sent.push(data);
        if (data.command === 'login') {
          if (data.data.token === cloud.rejectToken) this.receive({ category:'server', command:'login', data:{ status:'BAD' } });
          else this.receive({ category:'data', data:{ item:'User' } });
        }
        if (data.command === 'select') {
          const selected = () => this.receive({ category:'server', data:{ code:'I01' } });
          if (cloud.selection) cloud.selection.promise.then(selected); else selected();
        }
        if (data.component === 'Header' && data.command === 'SetState' && data.position === 'Up') this.stationOnly = false;
        if (data.component === 'Header' && data.command === 'Refresh') {
          if (!this.stationOnly) this.receive({ component:'Main', data:cloud.partial ? { current:20 } : cloud.main });
          this.stations();
        }
        if (data.component === 'Stations' && data.command === 'Start') {
          cloud.runs.push({ StId:data.id, isRunning:true, runningEntries:[{ handleID:++cloud.handle }] });
          if (cloud.dropAfterStart) this.close();
        }
        if (data.component === 'Stations' && data.command === 'Stop') cloud.runs = cloud.runs.filter(s => !s.runningEntries.some(e => data.handleID.includes(e.handleID)));
        if (data.component === 'Rainshutdown') cloud.main = { ...cloud.main, rainShutDown: data.command === 'Start' ? data.runtime : 0 };
        if (data.command === 'AutoStatus') { this.stationOnly = true; if (!cloud.silent) this.stations(); }
      }
      stations() { if (!cloud.silent) this.receive({ component:'Stations', data:cloud.runs }); }
    }();
    this.sockets.push(socket); return socket;
  };
  request = async path => {
    this.http.push(path);
    if (this.httpFailure) throw new Error(this.httpFailure);
    if (path.includes('get-token')) return 'fresh-token';
    return { getdevicelistnew:[{ devicelist:[{ ctrlid:2479, typename:'LTD', active:0 }] }] };
  };
}
async function fixture(t, options = {}) {
  const cloud = new Cloud(), logs = [];
  const driver = new LiveDriver({ token:'secret-token', controllerId:2479, socketFactory:cloud.factory, logger:r => logs.push(r), waitMs:100, releaseMs:5, ...options });
  driver.request = cloud.request;
  const store = new Store();
  const engine = new Engine({ driver, store, mode:'live', allowControl:true, logger:r => logs.push(r), ...(options.clock ? { clock:options.clock } : {}) });
  t.after(async () => { await engine.queue; await driver.close(); store.close(); });
  return { cloud, logs, driver, store, engine };
}
const command = (engine, key, fn) => engine.command(key, key, {}, fn, new Date(engine.clock() + 60000).toISOString());

test('a start arriving during refresh reuses its session, with one cold handshake', async t => {
  const { engine, cloud, logs } = await fixture(t);
  cloud.selection = deferred();
  const refreshing = engine.refresh();
  // Allow the cold handshake to reach controller selection.
  while (!cloud.sent.some(p => p.command === 'select')) await sleep(1);
  const starting = command(engine, 'refresh-overlap', () => engine.start('1', 1));
  cloud.selection.resolve();
  await Promise.all([refreshing, starting]);
  assert.equal(cloud.sockets.length, 1);
  assert.equal(cloud.http.length, 1);
  assert.equal(cloud.sent.filter(p => p.command === 'Start').length, 1);
  assert.ok(logs.some(r => r.stage === 'session_reuse' && r.reused));
  for (const stage of ['device_list','socket_connect','socket_login','controller_select','main_status','station_status','command_queue','start_confirmation']) assert.ok(logs.some(r => r.stage === stage), stage);
  assert.equal(JSON.stringify(logs).includes('secret-token'), false);
});

test('queued refreshes coalesce and yield to a command that supplies their observation', async t => {
  const { engine, cloud } = await fixture(t);
  const gate = deferred();
  const blocking = engine.serial(() => gate.promise);
  await Promise.resolve();
  const refresh = engine.refresh();
  assert.equal(engine.refresh(), refresh);
  const starting = command(engine, 'priority-start', () => engine.start('1', 1));
  gate.resolve();
  await Promise.all([blocking, refresh, starting]);
  assert.equal(cloud.sockets.length, 1);
  assert.equal(cloud.sent.filter(p => p.component === 'Header' && p.command === 'Refresh').length, 1);
});

test('stop and next reuse a session and wait for stop confirmation before starting', async t => {
  const { engine, cloud } = await fixture(t);
  await command(engine, 'initial-start', () => engine.start('1', 1));
  cloud.silent = true;
  const next = command(engine, 'walking-next', () => engine.next('2', 5));
  while (!cloud.sent.some(p => p.command === 'Stop')) await sleep(1);
  assert.equal(cloud.sent.filter(p => p.command === 'Start').length, 1);
  cloud.silent = false;
  cloud.sockets[0].stations();
  await next;
  assert.equal(cloud.sockets.length, 1);
  assert.deepEqual(cloud.sent.filter(p => ['Start','Stop'].includes(p.command)).map(p => p.command), ['Start','Stop','Start']);
  assert.equal(engine.state().zones.find(z => z.id === '2').owned, true);
});

test('snapshots retain receipt times; stale partial status cannot initiate watering', async t => {
  let now = Date.now();
  const { engine, cloud, driver } = await fixture(t, { clock:() => now });
  await engine.refresh({ interactive:true });
  const observed = driver.session.snapshot().receivedAt;
  now += 10000;
  assert.equal(driver.session.snapshot().receivedAt, observed);
  cloud.partial = true;
  await assert.rejects(command(engine, 'stale-status', () => engine.start('1', 1)), /status is stale/);
  assert.equal(cloud.sent.some(p => p.command === 'Start'), false);
});

test('fresh activity and rain checks run again when reusing a warm session', async t => {
  let now = Date.now();
  const { engine, cloud } = await fixture(t, { clock:() => now });
  await engine.refresh({ interactive:true });
  now += 5000;
  cloud.main.rainShutDown = 3600;
  await assert.rejects(command(engine, 'new-rain-hold', () => engine.start('1', 1)), /Rain delay is active/);
  assert.equal(cloud.sent.some(p => p.command === 'Start'), false);
});

test('a disconnect after send never causes replay, including a duplicate request', async t => {
  const { engine, cloud } = await fixture(t);
  cloud.dropAfterStart = true;
  const start = () => command(engine, 'unknown-start', () => engine.start('1', 1));
  await assert.rejects(start(), /connection lost/);
  await assert.rejects(start(), /unknown outcome/);
  assert.equal(cloud.sent.filter(p => p.command === 'Start').length, 1);
  assert.equal(cloud.sockets.length, 1);
  assert.equal(engine.state().operations[0].state, 'failed');
});

test('confirmation requires a new packet and fails without replay when it is missing', async t => {
  const { cloud, driver } = await fixture(t, { waitMs:20 });
  cloud.runs = [{ StId:'1', runningEntries:[{ handleID:100 }] }];
  await driver.withSession(async s => {
    cloud.silent = true;
    await assert.rejects(s.start('1', 1), /No confirmation for zone start/);
  });
  assert.equal(cloud.sent.filter(p => p.command === 'Start').length, 1);
});

test('background reads do not renew an interactive idle timeout; idle releases selection', async t => {
  const { driver, cloud } = await fixture(t, { idleMs:40 });
  await driver.withSession(async () => {});
  const keepUntil = driver.session.keepUntil;
  await sleep(15);
  await driver.withSession(async () => {}, { interactive:false, forceFresh:true });
  assert.equal(driver.session.keepUntil, keepUntil);
  await sleep(40);
  assert.equal(driver.session, null);
  assert.equal(cloud.sent.filter(p => p.command === 'deselect').length, 1);
});

test('maximum lifetime and disconnected sessions force a new handshake', async t => {
  let now = Date.now();
  const { driver, cloud } = await fixture(t, { clock:() => now, maxSessionMs:5000 });
  await driver.withSession(async () => {});
  now += 6000;
  await driver.withSession(async () => {});
  assert.equal(cloud.sockets.length, 2);
  cloud.sockets[1].close();
  await driver.withSession(async () => {});
  assert.equal(cloud.sockets.length, 3);
});

test('station deltas preserve inventory while session buffers remain bounded', async t => {
  const { driver, cloud } = await fixture(t);
  await driver.withSession(async s => {
    for (let i = 0; i < 1000; i++) cloud.sockets[0].receive({ component:'Stations', data:[] });
    assert.equal(s.events.length, 256);
    assert.equal(s.snapshot().stations[0].name, 'Garden 1');
  });
});

test('every physical write rechecks its deadline, including between rain stop and start', async t => {
  let now = Date.now();
  const { driver, cloud } = await fixture(t, { clock:() => now });
  await assert.rejects(driver.withSession(async s => {
    const originalSend = s.send.bind(s);
    s.send = (packet, write) => {
      originalSend(packet, write);
      if (packet.component === 'Rainshutdown' && packet.command === 'Stop') now += 2000;
    };
    await s.rain(12);
  }, { deadline:now + 1000 }), /expired before sending/);
  assert.deepEqual(cloud.sent.filter(p => p.component === 'Rainshutdown').map(p => p.command), ['Stop']);
});

test('opening the app during a background handshake keeps the shared session warm', async t => {
  const { engine, cloud, driver } = await fixture(t);
  cloud.selection = deferred();
  const refresh = engine.refresh();
  while (!cloud.sent.some(p => p.command === 'select')) await sleep(1);
  engine.prepare();
  cloud.selection.resolve();
  await refresh;
  assert.ok(driver.session.keepUntil > Date.now() + 80000);
  assert.equal(cloud.sockets.length, 1);
});

test('warm reads restore full status after a command selects station-only updates', async t => {
  const { driver, engine, cloud } = await fixture(t);
  await command(engine, 'stream-start', () => engine.start('1', 1));
  assert.equal(cloud.sockets[0].stationOnly, true);
  await engine.refresh();
  assert.equal(cloud.sockets[0].stationOnly, false);
  assert.equal(driver.session.snapshot().status.controllerMode, 2);
  assert.equal(cloud.sockets.length, 1);
});

test('a new session asks for the full status stream even if Tucor kept station-only mode', async t => {
  const { engine, cloud } = await fixture(t);
  cloud.stickyStationOnly = true;
  await engine.refresh();
  assert.equal(engine.state().status.controllerMode, 2);
  const select = cloud.sent.findIndex(p => p.command === 'select');
  assert.ok(cloud.sent.slice(select).findIndex(p => p.command === 'SetState') < cloud.sent.slice(select).findIndex(p => p.command === 'Refresh'));
});

test('the hourly session cap refuses before any Tucor contact and persists in the ledger', async t => {
  const store = new Store();
  const ledger = { load: () => store.get('guard'), save: v => store.set('guard', v) };
  let now = Date.now();
  const { driver, cloud } = await fixture(t, { clock:() => now, limits:{ sessionsPerHour:2, loginsPerDay:6 }, ledger, maxSessionMs:1000 });
  await driver.withSession(async () => {});
  now += 2000;
  await driver.withSession(async () => {});
  now += 2000;
  await assert.rejects(driver.withSession(async () => {}, { user:true }), /connection limit reached \(2 per hour\)/);
  assert.equal(cloud.sockets.length, 2);
  const restarted = new LiveDriver({ token:'x', controllerId:2479, ledger, clock:() => now, limits:{ sessionsPerHour:2, loginsPerDay:6 } });
  assert.equal(restarted.connection().sessionsLastHour, 2);
});

test('a failed connection backs off automatic contact but lets a person retry', async t => {
  let now = Date.now();
  const { driver, engine, cloud } = await fixture(t, { clock:() => now, random:() => 0.5 });
  cloud.httpFailure = 'Tucor HTTP 502';
  await assert.rejects(engine.refresh({ interactive:true }), /HTTP 502/);
  cloud.httpFailure = null;
  await assert.rejects(engine.refresh({ interactive:true }), /Waiting 1 min before contacting Tucor/);
  assert.equal(cloud.http.length, 1);
  assert.match(engine.state().connection.lastError, /HTTP 502/);
  await command(engine, 'person-retry', () => engine.start('1', 1));
  assert.equal(driver.connection().retryAt, null);
  assert.equal(driver.connection().history[0].ok, true);
});

test('a rejected cached token costs one password login and no per-session token checks', async t => {
  let now = Date.now();
  const { driver, cloud } = await fixture(t, { clock:() => now, user:'garden', password:'pw', maxSessionMs:1000 });
  cloud.rejectToken = 'secret-token';
  await driver.withSession(async () => {});
  now += 2000;
  await driver.withSession(async () => {});
  assert.deepEqual(cloud.http.filter(p => p.includes('token')), ['/api/get-token']);
  assert.equal(driver.connection().loginsToday, 1);
  assert.equal(cloud.sockets.length, 3);
});

test('pushed controller updates reach the app without another request', async t => {
  const { engine, cloud } = await fixture(t);
  await engine.refresh({ interactive:true });
  const refreshes = cloud.sent.filter(p => p.command === 'Refresh').length;
  cloud.sockets[0].receive({ component:'Stations', data:[{ StId:'2', isRunning:true, runningEntries:[{ handleID:9 }] }] });
  assert.equal(engine.state().zones.find(z => z.id === '2').running, true);
  assert.equal(cloud.sent.filter(p => p.command === 'Refresh').length, refreshes);
});

test('a refused command keeps the healthy session instead of logging in again', async t => {
  const { engine, cloud } = await fixture(t);
  cloud.runs = [{ StId:'2', isRunning:true, runningEntries:[{ handleID:7 }] }];
  await assert.rejects(command(engine, 'refused-start', () => engine.start('1', 1)), /Another zone is running/);
  cloud.runs = [];
  cloud.sockets[0].stations();
  await command(engine, 'second-start', () => engine.start('1', 1));
  assert.equal(cloud.sockets.length, 1);
});

test('weather automation answers from its own record and connects only to write', async t => {
  const { engine, cloud } = await fixture(t);
  engine.configurePolicy({ mode:'automatic', holdHours:12 });
  const wet = { intensityMmH:2, observedAt:new Date().toISOString() };
  const first = await engine.observeWeather(wet);
  assert.equal(first.applied, true);
  const sessions = cloud.sockets.length;
  const second = await engine.observeWeather(wet);
  assert.equal(second.preserved, 'Weather delay already covers this period');
  assert.equal(cloud.sockets.length, sessions);
  assert.equal(cloud.sent.filter(p => p.component === 'Rainshutdown' && p.command === 'Start').length, 1);
});

test('a rain delay cleared outside 2core stops counting as a known hold', async t => {
  const { engine, cloud } = await fixture(t);
  engine.configurePolicy({ mode:'automatic', holdHours:12 });
  await command(engine, 'manual-hold', () => engine.rain(24));
  cloud.main = { ...cloud.main, rainShutDown:0 };
  await engine.refresh({ interactive:true, forceFresh:true });
  assert.equal(engine.state().rain, null);
  const decision = await engine.observeWeather({ intensityMmH:2, observedAt:new Date().toISOString() });
  assert.equal(decision.applied, true);
});
