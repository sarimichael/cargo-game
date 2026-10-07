// Phase-3 process-level restart tests: the real local server (server/index.js) is started as a
// child process and killed with SIGKILL, including while requests are in flight. Synthetic play
// money in temporary data directories only. Run: node --test audit/tests/*.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerAdapter, aid, bet, act, ledgerInvariant } from '../lib/harness.mjs';
import { splitmix } from '../lib/seeds.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
let nextPort = 20000 + Math.floor(Math.random() * 20000);
async function startServer(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = nextPort++;
    const proc = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), CARGO_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    const ready = await new Promise(resolve => {
      proc.stdout.on('data', d => { if (String(d).includes('Cargo is ready')) resolve(true); });
      proc.on('exit', () => resolve(false));
    });
    if (ready) return { proc, url: 'http://127.0.0.1:' + port, kill: () => new Promise(r => { if (proc.exitCode !== null) return r(); proc.on('exit', r); proc.kill('SIGKILL'); }) };
  }
  throw new Error('could not start server');
}
function httpClient() {
  let cookie = '', url = '';
  return {
    at(u) { url = u; return this; }, cookie: () => cookie,
    async get(p) { const r = await fetch(url + p, { headers: { Cookie: cookie } }); const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: r.status, body: await r.json() }; },
    async post(p, body) { const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: url }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; }
  };
}
const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-restart-'));

test('SIGKILL during play: every acknowledged action survives, the file stays valid, and retries apply exactly once', async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rng = splitmix('p3-sigkill'), c = httpClient(); let server = await startServer(dir); c.at(server.url);
  await c.get('/api/session');
  let acknowledged = 0, inFlightAtKill = 0, retriedAfterRestart = 0, replayed = 0, reapplied = 0;
  for (let cycle = 0; cycle < 6; cycle++) {
    const killAfter = 40 + rng.int(160), deadline = Date.now() + killAfter;
    let pending = null;
    // Issue sequential actions until the kill time; the kill lands while a request may be in flight.
    const killer = new Promise(r => setTimeout(async () => { await server.kill(); r(); }, killAfter));
    while (Date.now() < deadline) {
      const st = await c.get('/api/session').catch(() => null); if (!st) break;
      const s = st.body, r = s.round;
      const [route, body] = r?.status === 'active'
        ? (r.step >= 1 && rng.int(3) === 0 ? [`/api/rounds/${r.id}/collect`, { containerId: 'all' }] : r.step < r.maxStops ? [`/api/rounds/${r.id}/advance`, {}] : [`/api/rounds/${r.id}/collect`, { containerId: 'all' }])
        : s.session.balanceCents < 3000 ? ['/api/reset', {}] : ['/api/rounds', { difficulty: rng.pick(['easy', 'medium', 'hard', 'expert']), stakeCents: 300 + rng.int(2700), clientSeed: 'kill-' + cycle, expectedSeedHash: s.session.nextSeedHash }];
      pending = { route, body: { ...body, revision: s.session.revision, actionId: aid('k') } };
      const res = await c.post(pending.route, pending.body).catch(() => null);
      if (!res) { inFlightAtKill++; break; }
      assert.ok([200, 409].includes(res.status), `${route} → ${res.status}`);
      if (res.status === 200) { acknowledged = Math.max(acknowledged, res.body.session.revision); pending = null; }
    }
    await killer;
    const persisted = readState(dir); // must parse: rename is atomic
    const session = Object.values(persisted.sessions)[0];
    assert.ok(session.revision >= acknowledged, `persisted revision ${session.revision} < acknowledged ${acknowledged}`);
    assert.ok(ledgerInvariant(session).ok);
    server = await startServer(dir); c.at(server.url);
    if (pending) { // the request in flight at the kill: an exact retry must apply at most once
      const before = readState(dir).sessions[session.id];
      const retry = await c.post(pending.route, pending.body);
      retriedAfterRestart++;
      assert.ok([200, 409].includes(retry.status));
      const after = readState(dir).sessions[session.id];
      if (retry.body.replayed) { // committed before the kill: the retry must not apply again
        assert.equal(after.revision, before.revision); assert.equal(after.ledger.length, before.ledger.length);
      } else if (retry.status === 200) { // lost by the kill: the retry applies exactly once
        assert.equal(after.revision, before.revision + 1);
      } else assert.equal(after.revision, before.revision); // a refused retry changes nothing
      assert.ok(ledgerInvariant(after).ok);
      if (retry.body.replayed) replayed++; else if (retry.status === 200) reapplied++;
    }
  }
  await server.kill();
  const final = Object.values(readState(dir).sessions)[0];
  assert.ok(ledgerInvariant(final).ok); assert.equal(new Set(final.ledger.map(e => e.id)).size, final.ledger.length);
  t.diagnostic(`acknowledged revision ${acknowledged}; in flight at a kill: ${inFlightAtKill}; retried after restart: ${retriedAfterRestart} (replayed ${replayed}, applied ${reapplied}); rounds ${Object.keys(final.rounds).length}`);
  assert.ok(acknowledged > 10);
});

test('an active voyage and a final-port voyage both survive a crash and can be settled afterwards', async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const c = httpClient(); let server = await startServer(dir); c.at(server.url);
  const s = (await c.get('/api/session')).body;
  const b = await c.post('/api/rounds', { difficulty: 'expert', stakeCents: 3000, clientSeed: 'crash', expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('cb') });
  await server.kill();
  // Test-only fixture while the server is stopped: make every stop safe so the final port is reachable.
  const state = readState(dir), id = b.body.round.id; Object.values(state.sessions)[0].rounds[id].hazards = { A: [20], B: [20], C: [20] };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  server = await startServer(dir); c.at(server.url);
  assert.equal((await c.get('/api/session')).body.round.status, 'active');
  for (let i = 0; i < 10; i++) { const st = (await c.get('/api/session')).body; assert.equal((await c.post(`/api/rounds/${id}/advance`, { revision: st.session.revision, actionId: aid('ca') })).status, 200); }
  await server.kill(); server = await startServer(dir); c.at(server.url);
  const atPort = (await c.get('/api/session')).body;
  assert.equal(atPort.round.status, 'active'); assert.equal(atPort.round.step, 10); // F05: survivors still uncredited after a crash
  const col = await c.post(`/api/rounds/${id}/collect`, { revision: atPort.session.revision, actionId: aid('cc'), containerId: 'all' });
  assert.equal(col.status, 200); assert.equal(col.body.round.status, 'settled');
  await server.kill(); assert.ok(ledgerInvariant(Object.values(readState(dir).sessions)[0]).ok);
});

test('worker: a fresh isolate (restart) on the same database continues the voyage and replays earlier actions', async t => {
  const a = await workerAdapter(); t.after(() => a.close()); const c = a.client();
  const b = await bet(c); await c.mutate(s => { s.rounds[s.currentRoundId].hazards = { A: [20], B: [20], C: [20] }; });
  const advBody = { revision: b.body.session.revision, actionId: aid('wi') };
  assert.equal((await c.post(`/api/rounds/${b.body.round.id}/advance`, advBody)).status, 200);
  const { default: freshWorker } = await import('../../server/worker.js?isolate=' + Date.now());
  a.useWorker(freshWorker);
  const replay = await c.post(`/api/rounds/${b.body.round.id}/advance`, advBody);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  assert.equal((await act(c, `/api/rounds/${b.body.round.id}/collect`, { containerId: 'all' })).status, 200);
  assert.ok(ledgerInvariant(c.raw()).ok);
});

test('KNOWN DEFECT F07: two server processes sharing a data directory erase an acknowledged wager', async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await startServer(dir), B = await startServer(dir); // both start: no lock or detection
  const a = httpClient().at(A.url), b = httpClient().at(B.url);
  const s = (await a.get('/api/session')).body;
  const placed = await a.post('/api/rounds', { difficulty: 'easy', stakeCents: 3000, clientSeed: 'f07', expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('f07') });
  assert.equal(placed.status, 200); assert.equal(placed.body.session.balanceCents, 97000);
  await b.get('/api/session'); // B persists its own in-memory state, which predates A's session
  await A.kill(); await B.kill();
  const aId = /cargo_session=([a-f0-9]{64})/.exec(a.cookie())[1];
  assert.equal(aId in readState(dir).sessions, false); // the acknowledged debit and active voyage are gone
});
