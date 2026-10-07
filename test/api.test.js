import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

async function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cargo-test-')),store=new Store(directory),app=createApp(store);await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+app.address().port;let cookie='';
 t.after(async()=>{await new Promise(resolve=>app.close(resolve));fs.rmSync(directory,{recursive:true,force:true});});
 async function get(endpoint='/api/session',extra={}){const r=await fetch(url+endpoint,{headers:{Cookie:cookie,...extra}});const c=r.headers.get('set-cookie');if(c)cookie=c.split(';')[0];return {status:r.status,body:await r.json()};}
 async function post(endpoint,input,extra={}){const r=await fetch(url+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:url,...extra},body:JSON.stringify(input)});return {status:r.status,body:await r.json()};}
 return {store,directory,url,get,post,cookie:()=>cookie};}
test('HTTP flow rejects duplicate credits, races and cross-origin mutations; survives a restart',async t=>{
 const f=await fixture(t),initial=(await f.get()).body;
 const payload={difficulty:'easy',stakeCents:3000,clientSeed:'api-test',expectedSeedHash:initial.session.nextSeedHash,revision:0,actionId:'begin-0001'};
 const started=await f.post('/api/rounds',payload);assert.equal(started.status,200);assert.equal(started.body.session.balanceCents,97000);
 const again=await f.post('/api/rounds',payload);assert.equal(again.status,200);assert.equal(again.body.replayed,true);assert.equal(again.body.round.id,started.body.round.id);assert.equal(again.body.session.balanceCents,97000);
 const conflict=await f.post('/api/rounds',{...payload,stakeCents:3003});assert.equal(conflict.status,409);
 const id=started.body.round.id;
 const race=await Promise.all([f.post('/api/rounds/'+id+'/advance',{revision:1,actionId:'advance-001'}),f.post('/api/rounds/'+id+'/advance',{revision:1,actionId:'advance-002'})]);
 assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);let state=(await f.get()).body;assert.equal(state.round.step,1);
 const collectPayload={revision:state.session.revision,actionId:'collect-all-01',containerId:'all'};
 if(state.round.status==='active'){const collected=await f.post('/api/rounds/'+id+'/collect',collectPayload);assert.equal(collected.status,200);const repeated=await f.post('/api/rounds/'+id+'/collect',collectPayload);assert.equal(repeated.body.session.balanceCents,collected.body.session.balanceCents);assert.equal(repeated.body.replayed,true);}
 state=(await f.get()).body;
 assert.deepEqual(new Store(f.directory).get(Object.keys(f.store.state.sessions)[0]),f.store.get(Object.keys(f.store.state.sessions)[0]));
 const cross=await f.post('/api/reset',{revision:state.session.revision,actionId:'reset-0001'},{Origin:'https://example.com'});assert.equal(cross.status,403);
 const invalid=await new Promise(resolve=>{const request=http.get(f.url+'/api/session',{headers:{Host:'evil.example'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',error=>{throw error;});});assert.equal(invalid,403);
 const another=await fetch(f.url+'/api/session');const otherCookie=another.headers.get('set-cookie').split(';')[0];
 const foreign=await fetch(f.url+'/api/rounds/'+id,{headers:{Cookie:otherCookie}});assert.equal(foreign.status,404);
});
test('live proofs never expose server seeds; invalid input cannot alter persisted state',async t=>{
 const f=await fixture(t),initial=(await f.get()).body;
 const result=await f.post('/api/rounds',{difficulty:'hard',stakeCents:3000,clientSeed:'proof',expectedSeedHash:initial.session.nextSeedHash,revision:0,actionId:'bet-proof-0001'});
 assert.equal(result.status,200);assert.equal(result.body.round.proof.serverSeed,undefined);assert.equal(result.body.round.proof.hazards,undefined);
 const old=JSON.stringify(f.store.state);
 assert.equal((await f.post('/api/rounds/'+result.body.round.id+'/collect',{revision:1,actionId:'bad-collect-001',containerId:'A'})).status,409);assert.equal(JSON.stringify(f.store.state),old);
 assert.equal((await f.post('/api/reset',{revision:1,actionId:'reset-001'})).status,409);assert.equal(JSON.stringify(f.store.state),old);
 assert.equal((await f.get('/data/state.json')).status,404);
});
