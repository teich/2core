import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../server/http.mjs';

const origin='https://garden.example.ts.net';
const engine={mode:'demo',state:()=>({available:true}),refresh:async()=>{}};
const key='test-access-key';

test('installable app assets are served with their expected content types',async t=>{
  const server=createServer(engine,key);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  for(const [path,type] of [['/manifest.webmanifest','application/manifest+json'],['/service-worker.js','text/javascript'],['/apple-touch-icon.png','image/png'],['/icon-192.png','image/png'],['/icon-512.png','image/png']]) {
    const response=await fetch(`${base}${path}`);
    assert.equal(response.status,200,path);
    assert.match(response.headers.get('content-type'),new RegExp(`^${type.replace('+','\\+')}`),path);
  }
});

test('TCP requests cannot impersonate Tailscale with any proxy headers',async t=>{
  const server=createServer(engine,key);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={'Tailscale-User-Login':'owner@example.com','X-Forwarded-For':'100.64.0.1','X-Forwarded-Proto':'https',Host:'garden.example.ts.net'};
  assert.equal((await fetch(`${base}/api/state`,{headers})).status,401);
  assert.deepEqual(await (await fetch(`${base}/api/auth`,{headers})).json(),{authenticated:false,mode:'key'});
  assert.equal((await fetch(`${base}/api/state`,{headers:{Authorization:`Bearer ${key}`}})).status,200);
});

test('private Unix transport authenticates reads and restricts implicit writes to same origin',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'2core-auth-'));
  const socket=join(folder,'auth.sock');
  const server=createServer(engine,key,{trustedOrigin:origin});
  await new Promise(resolve=>server.listen(socket,resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));rmSync(folder,{recursive:true,force:true});});
  const request=(path,extra={},method='GET')=>new Promise((resolve,reject)=>{
    const req=http.request({socketPath:socket,path,method,headers:{Host:'garden.example.ts.net',...(method==='POST'?{'Content-Type':'application/json'}:{}),...extra}},res=>{
      let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));
    });req.on('error',reject);req.end(method==='POST'?'{}':undefined);
  });
  assert.deepEqual((await request('/api/auth')).body,{authenticated:true,mode:'tailscale'});
  assert.equal((await request('/api/state')).status,200);
  assert.equal((await request('/api/state',{Host:'local-tailscaled.sock'})).status,200);
  assert.equal((await request('/api/refresh',{},'POST')).status,403);
  assert.equal((await request('/api/refresh',{Origin:'https://attacker.example'},'POST')).status,403);
  assert.equal((await request('/api/refresh',{Origin:'null'},'POST')).status,403);
  assert.equal((await request('/api/refresh',{Origin:origin},'POST')).status,200);
  // Non-browser clients retain the explicit bearer-key path.
  assert.equal((await request('/api/refresh',{Authorization:`Bearer ${key}`},'POST')).status,200);
});
