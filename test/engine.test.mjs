import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { DemoDriver } from '../server/demo.mjs';
import { DEFAULT_POLICY, evaluateWeather } from '../server/weather.mjs';
import { currentNight, nextDueDate, resolvePlan } from '../lib/planner.mjs';
import { createServer } from '../server/http.mjs';

async function fixture(t, options = {}) {
  const store = new Store(); t.after(() => store.close());
  const driver = new DemoDriver();
  const engine = new Engine({ store, driver, ...options });
  await engine.refresh();
  return { engine, driver, store };
}
let sequence = 0;
const command = (engine, kind, body, fn, key = `test-command-${++sequence}`) => engine.command(key, kind, body, fn, new Date(Date.now() + 60000).toISOString());

test('different simultaneous starts serialize and reject overlap', async t => {
  const {engine, driver} = await fixture(t);
  const result = await Promise.allSettled([command(engine,'start1',{},()=>engine.start('1',1)),command(engine,'start2',{},()=>engine.start('2',5))]);
  assert.deepEqual(result.map(r=>r.status),['fulfilled','rejected']);
  assert.equal(driver.runs.length,1);
  await engine.stop('1'); await engine.start('2',5);
  assert.equal(driver.runs[0].zone,'2');
});

test('read-only rejects all physical writes but permits observation and notes', async t => {
  const {engine, driver} = await fixture(t,{mode:'live'});
  for (const fn of [()=>engine.start('1',1),()=>engine.stop(),()=>engine.rain(12)]) await assert.rejects(fn,/disabled/);
  engine.preferences('1',{name:'New name',favorite:true});
  engine.configurePolicy({mode:'automatic'});
  await engine.weather({intensityMmH:1,observedAt:new Date().toISOString()});
  assert.equal(driver.rainUntil,0); assert.equal(driver.nextHandle,1);
  assert.equal(engine.state().zones[0].name,'New name');
  assert.match(engine.state().weatherDecision.blocked,/disabled/);
});

test('external runs are not stoppable or replaced by the app',async t=>{
  const {engine,driver}=await fixture(t);
  driver.runs=[{zone:'3',handle:88,endsAt:Date.now()+60000}];
  await assert.rejects(engine.start('1',1),/Another zone/);
  await assert.rejects(engine.stop('3'),/outside 2core/);
  await engine.stop(); assert.equal(driver.runs.length,1);
});

test('timed run expires on controller and ownership is reconciled',async t=>{
  const {engine,driver,store}=await fixture(t);
  await engine.start('1',1); assert.equal(engine.state().zones[0].owned,true);
  driver.runs[0].endsAt=Date.now()-1;
  await engine.refresh(); assert.equal(engine.state().zones[0].running,false);
  assert.deepEqual(store.get('runs'),[]);
  for(const n of [0,-1,241,1.5,'5',NaN]) await assert.rejects(engine.start('1',n),/Expected integer/);
});

test('rain policy observes by default, preserves manual holds, and never clears on dry data',async t=>{
  const {engine,driver}=await fixture(t);
  const wet={observedAt:new Date().toISOString(),intensityMmH:1};
  await engine.weather(wet); assert.equal(driver.rainUntil,0);
  engine.configurePolicy({mode:'automatic'});
  await engine.rain(24); const manual=driver.rainUntil;
  await engine.weather(wet); assert.equal(driver.rainUntil,manual);
  await engine.rain(0); await engine.weather(wet);
  assert.ok(driver.rainUntil>Date.now()+11*3600000);
  const auto=driver.rainUntil; await engine.weather(wet); assert.equal(driver.rainUntil,auto);
  await engine.weather({...wet,intensityMmH:0}); assert.equal(driver.rainUntil,auto);
  await assert.rejects(engine.start('1',1),/Rain delay/);
  // User changed the hold using Tucor after our earlier automatic hold.
  driver.rainUntil=Date.now()+2*3600000; const external=driver.rainUntil;
  await engine.weather(wet); assert.equal(driver.rainUntil,external);
});

test('weather rejects stale and incomplete forecasts; exact fresh thresholds work',()=>{
  const now=Date.now(); const sample={observedAt:new Date(now).toISOString()};
  assert.equal(evaluateWeather({...sample,intensityMmH:.25},DEFAULT_POLICY,now).wet,true);
  assert.equal(evaluateWeather({...sample,forecastMm:5,forecastProbability:70},DEFAULT_POLICY,now).wet,true);
  assert.equal(evaluateWeather({...sample,forecastMm:5},DEFAULT_POLICY,now).wet,false);
  assert.equal(evaluateWeather({...sample,observedAt:new Date(now-1800001).toISOString(),intensityMmH:100},DEFAULT_POLICY,now).wet,false);
  assert.equal(evaluateWeather({},DEFAULT_POLICY,now).wet,false);
});

test('expired command cannot wait through connection and then water',async t=>{
  let now=Date.now(); const {engine,driver}=await fixture(t,{clock:()=>now});
  const original=driver.withSession.bind(driver);
  driver.withSession=async fn=>{now+=61000; return original(fn);};
  await assert.rejects(command(engine,'start',{},()=>engine.start('1',1)),/expired while connecting/);
  assert.equal(driver.nextHandle,1);
});

test('unknown/failed command outcome is never retried, including after restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'2core-test-')); const file=join(dir,'test.sqlite');
  let store=new Store(file); let attempts=0;
  try {
    let engine=new Engine({store,driver:new DemoDriver()});
    const fn=()=>{attempts++; throw new Error('Connection lost after send');};
    await assert.rejects(command(engine,'start',{},fn,'unknown-outcome'),/Connection lost/);
    store.set('zone:1',{notes:'Leaky elbow'}); store.close(); store=new Store(file);
    engine=new Engine({store,driver:new DemoDriver()});
    await assert.rejects(command(engine,'start',{},fn,'unknown-outcome'),/unknown outcome/);
    assert.equal(attempts,1); assert.equal(store.get('zone:1').notes,'Leaky elbow');
    const row=store.command('unknown-outcome');
    store.begin('pending-command',row.fingerprint);
    await assert.rejects(command(engine,'start',{},fn,'pending-command'),/unknown outcome/);
    assert.equal(attempts,1);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('HTTP authentication, command contract, and duplicate start end to end',async t=>{
  const {engine,driver}=await fixture(t);const server=createServer(engine,'test-access-key');
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/state`)).status,401);
  const headers={Authorization:'Bearer test-access-key','Content-Type':'application/json','Idempotency-Key':'http-start-key'};
  const opts={method:'POST',headers,body:JSON.stringify({minutes:1,deadline:new Date(Date.now()+60000).toISOString()})};
  assert.equal((await fetch(`${base}/api/zones/1/start`,opts)).status,200);
  assert.equal((await fetch(`${base}/api/zones/1/start`,opts)).status,200);
  assert.equal(driver.nextHandle,2);
  const state=await (await fetch(`${base}/api/state`,{headers})).json(); assert.equal(state.zones[0].owned,true);
  assert.equal((await fetch(`${base}/api/rain`,{method:'POST',headers:{...headers,'Idempotency-Key':'invalid-deadline'},body:'{"hours":12}'})).status,400);
  assert.equal((await fetch(`${base}/`)).headers.get('content-security-policy').includes("frame-ancestors 'none'"),true);
});

test('unknown rain or activity state cannot initiate watering',async t=>{
  const {engine,driver}=await fixture(t);
  const state=driver.state.bind(driver);
  driver.state=()=>{const s=state();delete s.status.rainShutDown;return s;};
  await assert.rejects(engine.start('1',1),/Rain delay status is unknown/);
  await assert.rejects(engine.rain(12),/Rain delay status is unknown/);
  driver.state=()=>{const s=state();s.stations[0].isRunning=null;return s;};
  await assert.rejects(engine.start('1',1),/Station activity is unknown/);
  assert.equal(driver.nextHandle,1);
});

test('state reports the confirmed run timing the UI draws from', async t => {
  const {engine} = await fixture(t, { clock: () => Date.parse('2026-09-28T10:00:00Z') });
  await engine.start('3', 15);
  const state = engine.state();
  const zone = state.zones.find(z => z.id === '3');
  assert.equal(zone.startedAt, '2026-09-28T10:00:00.000Z');
  assert.equal(zone.minutes, 15);
  assert.equal(zone.endsAt, '2026-09-28T10:15:00.000Z');
  assert.equal(state.zones.find(z => z.id === '4').startedAt, null);
});

test('zone issues are validated, normalized and returned with the zone', async t => {
  const {engine} = await fixture(t);
  engine.preferences('2', { issues: [{ issue: ' Leak ', at: '2026-09-28T10:00:00-07:00' }] });
  assert.deepEqual(engine.state().zones.find(z => z.id === '2').issues, [{ issue: 'Leak', at: '2026-09-28T17:00:00.000Z' }]);
  assert.deepEqual(engine.state().zones.find(z => z.id === '1').issues, []);
  for (const issues of ['Leak', [{ issue: '', at: '2026-09-28T10:00:00Z' }], [{ issue: 'x'.repeat(41), at: '2026-09-28T10:00:00Z' }], [{ issue: 'Leak', at: 'soon' }], Array(21).fill({ issue: 'Leak', at: '2026-09-28T10:00:00Z' })])
    assert.throws(() => engine.preferences('2', { issues }), /issue/);
});

test('watering intentions and night settings are validated, stored locally, and never reach Tucor', async t => {
  const {engine,driver}=await fixture(t,{mode:'live'});
  const server=createServer(engine,'test-access-key');
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`, headers={Authorization:'Bearer test-access-key','Content-Type':'application/json'};
  const post=(path,body)=>fetch(`${base}/api${path}`,{method:'POST',headers,body:JSON.stringify(body)});
  const res=await post('/zones/2/intent',{seconds:1500,cadence:{perWeek:2}});
  assert.equal(res.status,200);
  const initial = (await res.json()).intent;
  assert.match(initial.firstDue, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(initial,{seconds:1500,cadence:{perWeek:2},enabled:true,firstDue:initial.firstDue,waterDuringRain:false,seasonalPercent:100});
  assert.equal((await post('/zones/2/intent',{firstDue:'2026-10-02',enabled:false,waterDuringRain:true})).status,200);
  for (const bad of [{seconds:0},{seconds:14401},{cadence:{every:0}},{cadence:{every:2,perWeek:2}},{firstDue:'2026-02-30'},{colour:'red'},{waterDuringRain:'yes'},{waterDuringRain:1}]) assert.equal((await post('/zones/2/intent',bad)).status,400, JSON.stringify(bad));
  assert.equal((await post('/zones/99/intent',{seconds:60})).status,404);
  assert.equal((await post('/plan',{lanes:1,earliestStart:1380})).status,200);
  assert.equal((await post('/plan',{lanes:3})).status,400);
  const state=await (await fetch(`${base}/api/state`,{headers})).json();
  assert.deepEqual(state.plan.intents['2'],{seconds:1500,cadence:{perWeek:2},enabled:false,firstDue:'2026-10-02',waterDuringRain:true,seasonalPercent:100});
  assert.deepEqual(state.plan.settings,{earliestStart:1380,finishBeforeSunrise:15,hardDeadline:540,lanes:1});
  assert.equal(driver.runs.length,0);
  assert.equal((await fetch(`${base}/lib/planner.mjs`)).headers.get('content-type'),'text/javascript; charset=utf-8');
});

test('the weather station supplies the plan’s location', async t => {
  const {engine}=await fixture(t);
  engine.weatherSource={describe:()=>({configured:true,station:{id:'1',latitude:38.4,longitude:-122.7}})};
  engine.recordWeatherRead({sample:{observedAt:new Date().toISOString()}});
  assert.deepEqual(engine.state().location,{latitude:38.4,longitude:-122.7});
});

test('seasonal edits preserve baselines, scale the plan, and persist all zones atomically', async t => {
  const dir = mkdtempSync(join(tmpdir(), '2core-seasonal-')), file = join(dir, 'test.sqlite');
  const store = new Store(file), driver = new DemoDriver();
  // Existing production intentions predate seasonal percentages.
  const baseline = { seconds: 3600, cadence: { every: 2 }, firstDue: '2026-10-06', enabled: true, waterDuringRain: false };
  store.set('intent:1', baseline);
  store.set('intent:2', { ...baseline, enabled: false });
  const engine = new Engine({ store, driver, mode: 'live', clock: () => new Date(2026, 9, 6, 17).getTime() });
  await engine.refresh();
  driver.withSession = async () => { throw new Error('Plan edits must not contact Tucor'); };
  const server = createServer(engine, 'test-key');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api`, headers = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' };
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const state = async () => (await (await fetch(`${base}/state`, { headers })).json()).plan;
  assert.equal((await state()).intents['1'].seasonalPercent, 100);
  for (const value of [49, 201, 75.5, '100', null]) {
    assert.equal((await post('/zones/1/intent', { seasonalPercent: value })).status, 400);
    assert.equal((await post('/plan/seasonal', { seasonalPercent: value })).status, 400);
  }
  assert.equal((await post('/plan/seasonal', { seasonalPercent: 50, seconds: 60 })).status, 400);
  assert.equal((await post('/plan/seasonal', { seasonalPercent: 50 })).status, 200);
  let saved = await state();
  assert.ok(Object.values(saved.intents).every(i => i.seasonalPercent === 50));
  assert.equal(Object.keys(saved.intents).length, engine.state().zones.length);
  assert.deepEqual(saved.intents['2'], { ...baseline, enabled: false, seasonalPercent: 50 });
  const project = intents => resolvePlan({ zones: [{ id: '1' }, { id: '2' }], intents, start: new Date(2026, 9, 6), settings: { lanes: 1, earliestStart: 1440, hardDeadline: 90 } });
  assert.equal(project(saved.intents).nights[0].seconds, 1800);
  assert.equal((await post('/zones/1/intent', { seasonalPercent: 200 })).status, 200);
  saved = await state();
  assert.deepEqual(saved.intents['1'], { ...baseline, seasonalPercent: 200 });
  assert.equal(saved.intents['2'].seasonalPercent, 50);
  assert.deepEqual(project(saved.intents).nights[0].deferred, ['1']);
  assert.equal(project(saved.intents).zones[0].weeklySeconds, 25200);
  const proposal = await (await post('/plan/rebalance-preview', {})).json();
  assert.equal(proposal.beforePeakSeconds, 7200);
  assert.equal((await post('/plan/seasonal', { seasonalPercent: 150 })).status, 200);
  assert.equal((await post('/plan/rebalance', { token: proposal.token })).status, 409);
  saved = await state();
  assert.equal(project(saved.intents).nights[0].seconds, 5400);
  assert.deepEqual(saved.intents['1'], { ...baseline, seasonalPercent: 150 });
  const disk = new Store(file);
  try {
    const restarted = new Engine({ store: disk, driver: new DemoDriver() });
    assert.deepEqual(restarted.plan(), saved);
  } finally { disk.close(); }
  // A failed bulk write must not leave half the garden at a new percentage.
  const set = store.set.bind(store);
  store.set = (key, value) => { if (key === 'intent:2') throw new Error('Disk write failed'); return set(key, value); };
  try {
    assert.equal((await post('/plan/seasonal', { seasonalPercent: 100 })).status, 503);
    assert.deepEqual(await state(), saved);
  } finally { store.set = set; }
  assert.equal((await post('/plan/seasonal', { seasonalPercent: 100 })).status, 200);
  assert.deepEqual((await state()).intents['1'], { ...baseline, seasonalPercent: 100 });
});


test('initial staggering persists across restarts and repeated edits never move other zones', async t => {
  let now = new Date(2026, 9, 6, 17).getTime();
  const store = new Store(); t.after(() => store.close());
  for (const id of ['1', '2', '3']) store.set(`intent:${id}`, { seconds: 3600, cadence: { every: 2 }, enabled: true, firstDue: null });
  const driver = new DemoDriver();
  const engine = new Engine({ store, driver, clock: () => now });
  await engine.refresh();
  const initial = structuredClone(engine.plan().intents);
  assert.equal(new Set(Object.values(initial).map(i => i.firstDue)).size, 2);
  for (const day of [8, 10, 12]) {
    now = new Date(2026, 9, day, 17).getTime();
    engine.intent('1', { seconds: 60 * day, waterDuringRain: true });
    engine.intent('4', { seconds: 1200, cadence: { perWeek: 3 } });
    for (const id of ['1', '2', '3']) assert.equal(engine.plan().intents[id].firstDue, initial[id].firstDue);
  }
  const next = nextDueDate(engine.plan().intents['1'], currentNight(new Date(now)));
  engine.intent('1', { cadence: { every: 7 } });
  assert.equal(engine.plan().intents['1'].firstDue, next);
  assert.deepEqual(engine.plan().intents['2'], initial['2']);
  const saved = engine.plan();
  const restarted = new Engine({ store, driver, clock: () => now + 2 * 864e5 });
  assert.deepEqual(restarted.plan(), saved);
  assert.equal(driver.runs.length, 0);
});

test('seasonal disable preserves settings; rebalance needs current reviewed token and applies atomically', async t => {
  let now = new Date(2026, 9, 6, 17).getTime();
  const { engine, store, driver } = await fixture(t, { clock: () => now });
  for (const id of ['1', '2', '3']) engine.intent(id, { seconds: 3600, cadence: { every: 2 }, firstDue: '2026-10-06', waterDuringRain: id === '3' });
  const original = engine.plan().intents['3'];
  engine.intent('3', { enabled: false });
  assert.deepEqual(engine.plan().intents['3'], { ...original, enabled: false });
  const before = engine.plan(), proposal = engine.rebalancePreview();
  assert.equal(proposal.changes.length, 1);
  assert.deepEqual(engine.plan(), before); // Reviewing/cancelling cannot move dates.
  assert.throws(() => engine.rebalance({ token: 'unreviewed' }), /plan changed/);
  engine.intent('2', { seconds: 7200 });
  assert.throws(() => engine.rebalance({ token: proposal.token }), /plan changed/);
  const fresh = engine.rebalancePreview();
  const result = engine.rebalance({ token: fresh.token });
  assert.deepEqual(result.changes, fresh.changes);
  for (const c of fresh.changes) assert.equal(engine.plan().intents[c.zone].firstDue, c.firstDue);
  assert.deepEqual(engine.plan().intents['3'], { ...original, enabled: false });
  assert.throws(() => engine.rebalance({ token: fresh.token }), /plan changed/);
  engine.intent('3', { enabled: true });
  assert.deepEqual(engine.plan().intents['3'], original);
  const yesterday = engine.rebalancePreview();
  now += 864e5;
  assert.throws(() => engine.rebalance({ token: yesterday.token }), /plan changed/);
  const saved = engine.plan();
  const restarted = new Engine({ store, driver, clock: () => now });
  assert.deepEqual(restarted.plan(), saved);
  assert.equal(driver.runs.length, 0);
});

test('program preview validates overrides and never writes preferences or contacts Tucor', async t => {
  const { engine, driver, store } = await fixture(t, { mode: 'live' });
  for (const zone of engine.state().zones.filter(z => z.configured)) engine.intent(zone.id, { seconds: 600, cadence: { every: 2 } });
  engine.intent('2', { enabled: false });
  const before = structuredClone(engine.plan());
  driver.refresh = () => { throw new Error('Compiler must not contact controller'); };
  const server = createServer(engine, 'test-access-key');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/plan/program-preview`;
  const headers = { Authorization: 'Bearer test-access-key', 'Content-Type': 'application/json' };
  const post = body => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const base = await (await post({})).json();
  const comparison = await (await post({ enabledOverrides: { 2: true } })).json();
  assert.equal(base.status, 'candidate');
  assert.equal(comparison.summary.zones, base.summary.zones + 1);
  for (const body of [{ enabledOverrides: [] }, { enabledOverrides: { 2: 1 } }, { enabledOverrides: { 999: true } }, { rain: 0.25 }]) assert.equal((await post(body)).status, 400);
  assert.deepEqual(engine.plan(), before);
  assert.equal(driver.runs.length, 0);
  assert.equal(store.get('intent:2').enabled, false);
});

function compilerFixture(t) {
  const snapshot = JSON.parse(readFileSync(new URL('./fixtures/program-intents.json', import.meta.url)));
  const store = new Store(); t.after(() => store.close());
  for (const [id, intent] of Object.entries(snapshot.plan.intents)) store.set(`intent:${id}`, intent);
  store.set('planSettings', snapshot.plan.settings);
  store.set('lastObservation', { stations: snapshot.zones.map(z => ({ StId: z.id, name: z.id === '15' ? 'Vineyard Top' : z.id === '16' ? 'Vineyard Bottom' : z.name })), status: {} });
  let now = new Date(2026, 9, 6, 20).getTime();
  const driver = { withSession: () => { throw Error('No controller access allowed'); } };
  const engine = new Engine({ store, driver, mode: 'live', clock: () => now });
  return { engine, store, nextDay: () => { now += 864e5; } };
}

test('reviewed edits preserve the saved plan until a verified alternative is explicitly applied', t => {
  const { engine } = compilerFixture(t), before = structuredClone(engine.plan());
  const change = { intents: { 1: { cadence: { every: 7 } } } };
  const review = engine.planEditPreview({ change });
  assert.deepEqual(engine.plan(), before);
  assert.equal(review.assessment.status, 'needs-adjustment');
  assert.deepEqual(review.plan.seasonalZoneIds, ['15', '16']);
  assert.ok(review.alternatives.length);
  assert.throws(() => engine.planEditApply({ change, token: review.token }), /unfinished/);
  const option = review.alternatives[0];
  const result = engine.planEditApply({ change, token: review.token, alternativeId: option.id });
  assert.notEqual(result.assessment.status, 'needs-adjustment');
  assert.equal(result.plan.intents['1'].firstDue, option.adjustments.intents['1'].firstDue);
  assert.deepEqual(result.plan.intents['1'].cadence, { every: 7 });
  for (const id of Object.keys(before.intents).filter(id => id !== '1')) assert.deepEqual(result.plan.intents[id], before.intents[id]);
  assert.deepEqual(result.plan.settings, before.settings);
});

test('saving an unfinished plan is explicit and its seasonal warning survives reload', t => {
  const { engine, store } = compilerFixture(t);
  const change = { intents: { 1: { cadence: { every: 7 } } } }, review = engine.planEditPreview({ change });
  const saved = engine.planEditApply({ change, token: review.token, saveUnresolved: true });
  assert.equal(saved.assessment.status, 'needs-adjustment');
  assert.equal(engine.planEditPreview().assessment.status, 'needs-adjustment');
  const restarted = new Engine({ store, driver: {}, mode: 'live', clock: () => new Date(2026, 9, 6, 20).getTime() });
  assert.equal(restarted.planEditPreview().assessment.status, 'needs-adjustment');
});

test('review tokens bind edits, preferences, location, and the night; failures leave state intact', t => {
  const { engine, store, nextDay } = compilerFixture(t);
  const change = { intents: { 1: { seconds: 600 } } }, review = engine.planEditPreview({ change });
  assert.throws(() => engine.planEditApply({ change: { intents: { 1: { seconds: 1200 } } }, token: review.token }), /changed/);
  store.set('location', { latitude: 38, longitude: -122 });
  assert.throws(() => engine.planEditApply({ change, token: review.token }), /changed/);
  const fresh = engine.planEditPreview({ change }); nextDay();
  assert.throws(() => engine.planEditApply({ change, token: fresh.token }), /changed/);
  const current = engine.planEditPreview({ change }); engine.intent('2', { seconds: 1500 });
  assert.throws(() => engine.planEditApply({ change, token: current.token }), /changed/);
  const last = engine.planEditPreview({ change }), before = structuredClone(engine.plan());
  const originalSet = store.set.bind(store);
  store.set = (key, value) => { if (key === 'planSettings') throw Error('storage failure'); return originalSet(key, value); };
  assert.throws(() => engine.planEditApply({ change, token: last.token }), /storage failure/);
  store.set = originalSet;
  assert.deepEqual(engine.plan(), before);
});

test('seasonal selections persist after enabling vineyards and global scaling ignores empty controller slots', t => {
  const { engine, store } = compilerFixture(t);
  engine.current.stations.push({ StId: '99', name: '' });
  const change = { seasonalPercent: 100, intents: { 15: { enabled: true }, 16: { enabled: true } } };
  const review = engine.planEditPreview({ change });
  assert.notEqual(review.assessment.status, 'needs-adjustment');
  engine.planEditApply({ change, token: review.token });
  assert.deepEqual(store.get('planSeasonalZones'), ['15', '16']);
  assert.equal(engine.planEditPreview().assessment.scenarios.length, 3);
  assert.equal(engine.programPreview().status, 'candidate');
});

test('edit HTTP endpoints require auth, validate fields, and use the reviewed commit path', async t => {
  const { engine } = compilerFixture(t);
  const server = createServer(engine, 'test-access-key');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/plan`;
  const headers = { Authorization: 'Bearer test-access-key', 'Content-Type': 'application/json' };
  const post = (path, body, custom = headers) => fetch(url + path, { method: 'POST', headers: custom, body: JSON.stringify(body) });
  assert.equal((await post('/edit-preview', {}, { 'Content-Type': 'application/json' })).status, 401);
  for (const change of [{ nope: true }, { intents: [] }, { intents: { 999: { seconds: 60 } } }, { settings: { lanes: 3 } }, { seasonalZoneIds: ['999'] }, { seasonalPercent: 201 }]) assert.ok((await post('/edit-preview', { change })).status >= 400);
  const change = { intents: { 1: { seconds: 600 } } }, response = await post('/edit-preview', { change });
  assert.equal(response.status, 200);
  const review = await response.json();
  assert.equal((await post('/edit-apply', { change, token: review.token })).status, 200);
  assert.equal(engine.plan().intents['1'].seconds, 600);
});
