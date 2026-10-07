// Phase 4A regression tests for F07 (local store ownership), P3-02 (missing-session detection) and
// P3-01 (JSON nesting limit). See CARGO_PHASE4A_REMEDIATION_REPORT.md.
// Synthetic play money, temporary directories and test-only fixtures only.
// Run: node --test audit/tests/*.test.js
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, aid, startSession, bet, act, ledgerInvariant } from '../lib/harness.mjs';
import { Store } from '../../server/store.js';
import { createSession } from '../../server/game.js';
import { parseJsonObject, actionFingerprint, MAX_JSON_DEPTH } from '../../server/protocol.js';
import { derivedSeed } from '../lib/seeds.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-p4a-'));
const lockFile = dir => path.join(dir, 'state.lock');
const writeLock = (dir, owner) => fs.writeFileSync(lockFile(dir), JSON.stringify(owner));
const deadPid = async () => { const p = spawn(process.execPath, ['-e', '0']); await new Promise(r => p.on('exit', r)); return p.pid; };
const nested = (depth, inner = '0') => '['.repeat(depth) + inner + ']'.repeat(depth);
const UNKNOWN = 'cargo_session=' + 'ab'.repeat(32);

// =============================================================== P3-01: JSON nesting limit
test('P3-01: parseJsonObject enforces the depth limit by structure, not by characters inside strings', () => {
  assert.equal(MAX_JSON_DEPTH, 32);
  const enc = s => new TextEncoder().encode(s);
  assert.deepEqual(parseJsonObject(enc(`{"x":${nested(MAX_JSON_DEPTH - 1)}}`)).x.flat(Infinity), [0]); // depth exactly 32 accepted
  for (const depth of [MAX_JSON_DEPTH, 100, 3011, 8100]) {
    assert.throws(() => parseJsonObject(enc(`{"x":${nested(depth)}}`)), e => e.status === 400 && e.code === 'JSON_TOO_DEEP', String(depth));
  }
  // Brackets and braces inside strings, including escaped quotes and backslashes, are not structure.
  const tricky = { s: '['.repeat(5000) + '{'.repeat(5000), q: 'a\\"[[[{{{', b: '\\', u: ' ]]]}}}', k: { '[[[': '"' } };
  assert.deepEqual(parseJsonObject(enc(JSON.stringify(tricky))), tricky);
  assert.deepEqual(parseJsonObject(enc('{"a":"\\\\","b":[[["\\"]]]"]]]}')), { a: '\\', b: [[['"]]]']]] });
  // Malformed JSON is still a 400 from JSON.parse, never a crash.
  assert.throws(() => parseJsonObject(enc('{"a":"unterminated')), e => e.status === 400);
  assert.throws(() => parseJsonObject(enc(']]]]')), e => e.status === 400);
});

test('P3-01: fingerprints of accepted requests are byte-identical to the Phase 3 values', () => {
  const pins = [
    [['/api/reset', { revision: 0, actionId: 'fp-pin-0001' }], '88e96447cfe233334a891e6aa429946b9765a1c6c92e32b936418bc8afe54504', 'ca7ff1387067e84999de05e89ec7afe5e0d9717d6bb1682c81e7c9956d7d244b'],
    [['/api/rounds', { difficulty: 'easy', stakeCents: 3001, clientSeed: '🚢 a"b{[', expectedSeedHash: 'ab'.repeat(32), revision: 7, actionId: 'fp-pin-0002' }], '4a6a175bd5960d647e9dedc45a5ab6077f7d528d7cf6f5917c974530aedd7f1c', '235ed235e917b197bac085a210f7198b1a91cc8b8798cefbfa66150822cf1a68'],
    [['/api/rounds/00000000-0000-4000-8000-000000000000/collect', { containerId: 'all', actionId: 'fp-pin-0003', revision: 3, nested: { b: [1, { z: 2, a: [3] }], a: null } }], 'a236740a838eedd737c432752f43697235d9241b9342137cf83f680d40615c7b', 'b269eb9b5e43cc9860138a2fa8d23d3b0bdf5e9d4c6c3ce11853953e573ffd74']];
  for (const [[p, input], current, legacy] of pins) assert.deepEqual(actionFingerprint(p, input), { current, legacy });
});

for (const [kind, make] of Object.entries(ADAPTERS)) {
  test(`P3-01 (${kind}): excessive nesting is refused with 400 at every depth up to the size limit; normal nesting works`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client(); const s = await startSession(c);
    for (const depth of [33, 3011, 5000, 8150]) {
      const before = JSON.stringify(c.raw());
      const r = await c.post('/api/reset', null, {}, `{"revision":${s.session.revision},"actionId":"deep-${depth}-x","x":${nested(depth)}}`);
      assert.equal(r.status, 400, String(depth)); assert.equal(r.body.code, 'JSON_TOO_DEEP');
      assert.equal(JSON.stringify(c.raw()), before);
    }
    const big = await c.post('/api/reset', null, {}, `{"revision":0,"actionId":"too-big-1","x":${nested(9000)}}`);
    assert.equal(big.status, 413); // size limit still applies first
    const ok = await c.post('/api/reset', null, {}, `{"revision":${s.session.revision},"actionId":"deep-ok-01","x":${nested(MAX_JSON_DEPTH - 1)},"s":"${'['.repeat(4000)}"}`);
    assert.equal(ok.status, 200);
  });

  // ============================================================= P3-02: missing-session detection
  test(`P3-02 (${kind}): a well-formed cookie for a missing session gets SESSION_NOT_FOUND and nothing is created`, async t => {
    const a = await make(); t.after(() => a.close());
    const fresh = a.client(); const first = await fresh.get('/api/session');
    assert.equal(first.status, 200); assert.equal(first.body.session.balanceCents, 100000); // genuine new visitor: unchanged
    const count = a.sessionCount(), lost = a.client(); lost.jar.set(UNKNOWN);
    for (const [method, p] of [['get', '/api/session'], ['get', '/api/rounds/00000000-0000-4000-8000-000000000000'], ['post', '/api/reset'], ['post', '/api/rounds']]) {
      const r = method === 'get' ? await lost.get(p) : await lost.post(p, { revision: 0, actionId: aid('nf') });
      assert.equal(r.status, 404, `${method} ${p}`); assert.equal(r.body.code, 'SESSION_NOT_FOUND', `${method} ${p}`);
    }
    assert.equal(lost.jar.header(), UNKNOWN); // no Set-Cookie: the original cookie is left alone
    assert.equal(a.sessionCount(), count); // no replacement wallet
  });

  test(`P3-02 (${kind}): starting a new demo session is an explicit POST, refused while a session exists`, async t => {
    const a = await make(); t.after(() => a.close());
    const lost = a.client(); lost.jar.set(UNKNOWN); const count = a.sessionCount();
    assert.equal((await lost.post('/api/session', {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await lost.post('/api/session', {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal(a.sessionCount(), count);
    const started = await lost.post('/api/session', {});
    assert.equal(started.status, 200); assert.equal(started.body.session.balanceCents, 100000); assert.equal(started.body.round, null);
    assert.equal(a.sessionCount(), count + 1);
    // The new cookie is only set by this explicit action.
    const live = a.client(); const b = await bet(live); const liveCount = a.sessionCount();
    const again = await live.post('/api/session', {});
    assert.equal(again.status, 409); assert.equal(again.body.code, 'SESSION_EXISTS');
    assert.equal(a.sessionCount(), liveCount);
    assert.equal(live.raw().rounds[b.body.round.id].status, 'active'); // existing session and active round untouched
    const noCookie = a.client(); assert.equal((await noCookie.post('/api/session', {})).status, 200); // explicit start without any cookie
  });

  test(`P3-02 (${kind}): a session that disappears mid-voyage is reported, not replaced, and existing sessions keep working`, async t => {
    const a = await make(); t.after(() => a.close());
    const keep = a.client(); const kb = await bet(keep);
    const c = a.client(); const b = await bet(c); const lostId = c.jar.id();
    if (kind === 'worker') a.sql.prepare('DELETE FROM cargo_sessions WHERE id = ?').run(lostId); else a.store.transaction(st => { delete st.sessions[lostId]; });
    const count = a.sessionCount();
    assert.equal((await c.post(`/api/rounds/${b.body.round.id}/advance`, { revision: 1, actionId: aid('gone') })).body.code, 'SESSION_NOT_FOUND');
    const read = await c.get('/api/session');
    assert.equal(read.status, 404); assert.equal(read.body.code, 'SESSION_NOT_FOUND'); assert.equal(c.jar.id(), lostId);
    assert.equal(a.sessionCount(), count);
    const other = await act(keep, `/api/rounds/${kb.body.round.id}/advance`); assert.equal(other.status, 200);
    assert.ok(ledgerInvariant(keep.raw()).ok);
  });
}

test('P3-02 (worker): a storage failure while starting a session returns a JSON 500, sets no cookie and creates nothing', async t => {
  // Regression for a defect found during phase 4A verification: an un-awaited promise let the
  // insert failure escape the Worker's error handler instead of producing the JSON error response.
  const { workerAdapter } = await import('../lib/harness.mjs');
  const a = await workerAdapter(); t.after(() => a.close());
  a.faults.beforeInsert = 1; const fresh = a.client(); const g = await fresh.get('/api/session');
  assert.equal(g.status, 500); assert.equal(g.body.code, 'SERVER_ERROR'); assert.equal(fresh.jar.id(), undefined);
  const lost = a.client(); lost.jar.set(UNKNOWN); a.faults.beforeInsert = 1;
  const p = await lost.post('/api/session', {});
  assert.equal(p.status, 500); assert.equal(p.body.code, 'SERVER_ERROR'); assert.equal(lost.jar.header(), UNKNOWN);
  assert.equal(a.sessionCount(), 0);
  assert.equal((await lost.post('/api/session', {})).status, 200); // the explicit retry then succeeds
});

// =============================================================== F07: exclusive data-directory ownership
test('F07: a second Store in the same process cannot write; after release the next owner reloads the latest state', t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s1 = new Store(dir); s1.transaction(st => { st.sessions.x = createSession('x', derivedSeed('p4a', 0)); });
  const s2 = new Store(dir); // constructed now, so its in-memory copy will go stale
  s1.transaction(st => { st.sessions.x.balanceCents -= 100; });
  assert.throws(() => s2.transaction(st => { st.sessions.y = {}; }), e => e.code === 'DATA_DIRECTORY_LOCKED');
  assert.equal(new Store(dir).get('x').balanceCents, 99900); // the acknowledged debit survives
  s1.release();
  s2.transaction(st => { st.sessions.y = { note: 'second owner' }; });
  const disk = new Store(dir);
  assert.equal(disk.get('x').balanceCents, 99900); // s2 reloaded on acquisition instead of writing its stale copy
  assert.equal(disk.get('y').note, 'second owner');
  s2.release(); assert.equal(fs.existsSync(lockFile(dir)), false);
});

test('F07: stale locks are recovered (dead PID, our own PID from an earlier process, old unreadable file); live or remote owners are refused', async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = os.hostname();
  for (const owner of [{ pid: await deadPid(), hostname: host, token: 'dead' }, { pid: process.pid, hostname: host, token: 'earlier-incarnation' }]) {
    writeLock(dir, owner); const s = new Store(dir).acquire();
    assert.notEqual(JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')).token, owner.token); s.release();
  }
  fs.writeFileSync(lockFile(dir), ''); const old = new Date(Date.now() - 60000); fs.utimesSync(lockFile(dir), old, old);
  new Store(dir).acquire().release();
  // Refused: a live process on this host (this test runner's parent), another host, or a fresh unreadable file.
  for (const owner of [{ pid: process.ppid, hostname: host, token: 'live' }, { pid: 1, hostname: 'another-host.example', token: 'remote' }]) {
    writeLock(dir, owner);
    assert.throws(() => new Store(dir).acquire(), e => e.code === 'DATA_DIRECTORY_LOCKED' && e.message.includes(lockFile(dir)));
    assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')).token, owner.token); // never removed
  }
  fs.writeFileSync(lockFile(dir), '');
  assert.throws(() => new Store(dir).acquire(), e => e.code === 'DATA_DIRECTORY_LOCKED');
  fs.rmSync(lockFile(dir));
});

test('F07: release never deletes another owner\'s lock, and a store that lost its lock refuses to write', t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Store(dir); s.transaction(st => { st.sessions.x = { n: 1 }; });
  const foreign = { pid: process.ppid, hostname: os.hostname(), token: 'someone-else' };
  writeLock(dir, foreign); // simulate the lock having been taken over
  const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  assert.throws(() => s.transaction(st => { st.sessions.x.n = 2; }), e => e.code === 'DATA_DIRECTORY_LOCKED');
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
  s.release();
  assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')).token, 'someone-else');
  fs.rmSync(lockFile(dir));
});

test('F07: when six processes race to recover one stale lock, exactly one becomes the owner', { timeout: 90000 }, async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let round = 0; round < 3; round++) {
    writeLock(dir, { pid: await deadPid(), hostname: os.hostname(), token: 'stale-' + round });
    const script = `import { Store } from ${JSON.stringify(path.join(root, 'server/store.js'))};
      try { const s = new Store(${JSON.stringify(dir)}).acquire(); console.log('OWNER'); setTimeout(() => { s.release(); }, 800); }
      catch (e) { console.log(e.code === 'DATA_DIRECTORY_LOCKED' ? 'REFUSED' : 'ERROR ' + e.message); }`;
    const results = await Promise.all(Array.from({ length: 6 }, () => new Promise(resolve => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script]); let out = ''; children.push(p);
      p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; }); p.on('exit', () => resolve(out.trim()));
    })));
    assert.equal(results.filter(r => r === 'OWNER').length, 1, JSON.stringify(results));
    assert.equal(results.filter(r => r === 'REFUSED').length, 5, JSON.stringify(results));
    assert.equal(fs.existsSync(lockFile(dir)), false); // the owner released on exit
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith('state.lock')), []); // no debris
  }
});

// ---------------------------------------------------------------- real server processes
// Every spawned server is registered and killed when this file finishes, whatever the outcome,
// so a failing assertion can never leave a process running (or the runner waiting on it).
const children = [];
after(() => { for (const p of children) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); });
let nextPort = 21000 + Math.floor(Math.random() * 20000);
function launch(dir) {
  const port = nextPort++, proc = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), CARGO_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  let out = '';
  const outcome = new Promise(resolve => {
    proc.stdout.on('data', d => { out += d; if (out.includes('Cargo is ready')) resolve({ ready: true }); });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', code => resolve({ ready: false, code }));
    setTimeout(() => resolve({ ready: false, code: 'timeout' }), 15000);
  });
  return { proc, url: 'http://127.0.0.1:' + port, outcome, output: () => out, exited: new Promise(r => proc.on('exit', (code, signal) => r({ code, signal }))) };
}

test('F07: two server processes started together on one folder — exactly one runs, the other exits with a clear message', { timeout: 90000 }, async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = launch(dir), B = launch(dir), [ra, rb] = await Promise.all([A.outcome, B.outcome]);
  t.after(() => { A.proc.kill('SIGKILL'); B.proc.kill('SIGKILL'); });
  assert.equal([ra, rb].filter(r => r.ready).length, 1, A.output() + B.output());
  const loser = ra.ready ? B : A, winner = ra.ready ? A : B, lostResult = ra.ready ? rb : ra;
  assert.equal(lostResult.code, 1); assert.match(loser.output(), /already (running|in use)/i); assert.match(loser.output(), /state\.lock/);
  // The running server keeps its data: the Phase 3 data-loss scenario no longer occurs.
  let cookie = ''; const s = await fetch(winner.url + '/api/session'); cookie = s.headers.get('set-cookie').split(';')[0];
  const session = await s.json();
  const placed = await fetch(winner.url + '/api/rounds', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: winner.url }, body: JSON.stringify({ difficulty: 'easy', stakeCents: 3000, clientSeed: 'p4a', expectedSeedHash: session.session.nextSeedHash, revision: 0, actionId: aid('p4a') }) });
  assert.equal(placed.status, 200);
  const third = launch(dir); assert.equal((await third.outcome).ready, false);
  winner.proc.kill('SIGTERM'); await winner.exited;
  const id = /cargo_session=([a-f0-9]{64})/.exec(cookie)[1];
  assert.equal(new Store(dir).get(id).balanceCents, 97000);
});

test('F07: graceful shutdown releases the lock; a crash leaves a stale lock that the next start recovers automatically', { timeout: 90000 }, async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const s = launch(dir); assert.equal((await s.outcome).ready, true); assert.ok(fs.existsSync(lockFile(dir)));
    s.proc.kill(signal); await s.exited;
    assert.equal(fs.existsSync(lockFile(dir)), false, signal);
  }
  const crashed = launch(dir); assert.equal((await crashed.outcome).ready, true);
  const r = await fetch(crashed.url + '/api/session'); const cookie = r.headers.get('set-cookie').split(';')[0];
  crashed.proc.kill('SIGKILL'); await crashed.exited;
  assert.ok(fs.existsSync(lockFile(dir))); // the crash could not clean up
  const next = launch(dir); assert.equal((await next.outcome).ready, true, next.output());
  t.after(() => next.proc.kill('SIGKILL'));
  const again = await fetch(next.url + '/api/session', { headers: { Cookie: cookie } });
  assert.equal(again.status, 200); // the session written before the crash is intact
  next.proc.kill('SIGTERM'); await next.exited; assert.equal(fs.existsSync(lockFile(dir)), false);
});
