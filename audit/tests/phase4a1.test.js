// Phase 4A.1 regression tests: exclusive ownership of the local save folder (review findings
// R1–R4), plus a bounded property test for the P3-01 depth limit. See CARGO_PHASE4A1_CORRECTION_REPORT.md.
// These tests assert SAFETY properties (single owner, no loss while held, no stale reads, acknowledged
// data preserved), not merely that a process started. They avoid fixed holding periods: owners hold
// until the test releases them. Run: node --test audit/tests/*.test.js
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../server/store.js';
import { acquireDirectoryLock as acquireLock } from '../../server/lock.js';
import { parseJsonObject, MAX_JSON_DEPTH } from '../../server/protocol.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = name => path.join(root, 'audit/fixtures', name);
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-p4a1-'));
const lockFile = dir => path.join(dir, 'state.lock');
// Accepts both the synchronous (phase 4A) and asynchronous (phase 4A.1) lock API, so the red baseline is meaningful.
const acquireDirectoryLock = dir => Promise.resolve().then(() => acquireLock(dir));
const children = [];
const descendants = pid => spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).flatMap(c => [...descendants(c), Number(c)]);
after(() => { for (const p of children) { for (const d of descendants(p.pid)) try { process.kill(d, 'SIGKILL'); } catch {} if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); } });
const track = p => { children.push(p); return p; };
const exited = p => new Promise(r => (p.exitCode !== null || p.signalCode !== null) ? r() : p.on('exit', r));
const waitFor = async (cond, ms = 15000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
const canUnshare = (() => { try { return spawnSync('unshare', ['--pid', '--fork', '--mount-proc', 'true'], { timeout: 5000 }).status === 0; } catch { return false; } })();

// A genuine stale lock: a real process takes the lock and is then killed with SIGKILL.
async function crashOwner(dir, { isolate = false } = {}) {
  const cmd = isolate ? 'unshare' : process.execPath, args = [fixture('lock-crash.mjs'), root, dir];
  const p = track(spawn(cmd, isolate ? ['--pid', '--fork', '--mount-proc', process.execPath, ...args] : args, { stdio: ['ignore', 'pipe', 'pipe'] }));
  let out = ''; p.stdout.on('data', d => { out += d; });
  await waitFor(() => out.includes('READY'));
  if (isolate) { // kill the namespaced node process itself (killing `unshare` alone would leave it running)
    const inner = descendants(p.pid);
    for (const pid of inner) process.kill(pid, 'SIGKILL');
    p.kill('SIGKILL'); await exited(p);
    // Wait until the process no longer exists, not merely until it was signalled: a namespace's PID 1 can show as a
    // zombie while its sockets are still being torn down, and during that window the lock rightly reports it live.
    await waitFor(() => inner.every(pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }));
  }
  p.kill('SIGKILL'); await exited(p);
  assert.ok(fs.existsSync(lockFile(dir)), 'the crash must leave a lock behind');
}

// N contenders start at the same instant against `dir`; owners hold until released by the test.
async function race(dir, n) {
  const signal = path.join(os.tmpdir(), 'cargo-p4a1-signal-' + randomUUID()), startAt = Date.now() + 700;
  const outs = Array(n).fill(null), procs = [];
  for (let i = 0; i < n; i++) {
    const p = track(spawn(process.execPath, [fixture('lock-contender.mjs'), root, dir, String(startAt), signal], { stdio: ['ignore', 'pipe', 'pipe'] }));
    let o = ''; p.stdout.on('data', d => { o += d; }); p.stderr.on('data', d => { o += d; }); p.on('exit', () => { outs[i] = o.trim(); });
    procs.push(p);
  }
  // Wait until every contender has either been refused (exited) or become an owner, then release.
  const owners = () => fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(path.basename(signal) + '.owner.')).length;
  await waitFor(() => outs.filter(o => o !== null).length + owners() >= n, 30000);
  await new Promise(r => setTimeout(r, 100)); // let any late (wrong) takeover surface while owners still hold
  fs.writeFileSync(signal, '');
  await Promise.all(procs.map(exited));
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(path.basename(signal))) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  return outs;
}

// =============================================================== R2: concurrent stale-lock recovery
for (const [n, rounds] of [[3, 15], [12, 6]]) {
  test(`R2: ${n} processes racing to recover a crashed owner's lock — exactly one owner, never lost while held (${rounds} rounds)`, { timeout: 300000 }, async t => {
    const tally = { owners: [], lost: 0, errors: [] };
    for (let r = 0; r < rounds; r++) {
      const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      await crashOwner(dir);
      const outs = await race(dir, n);
      tally.owners.push(outs.filter(o => o.startsWith('OWNER')).length);
      tally.lost += outs.filter(o => o === 'OWNER:LOST').length;
      tally.errors.push(...outs.filter(o => o.startsWith('ERROR')));
    }
    t.diagnostic(JSON.stringify(tally));
    assert.deepEqual(tally.errors, []);
    assert.ok(tally.owners.every(c => c === 1), `owners per round: ${tally.owners}`);
    assert.equal(tally.lost, 0, 'a live owner lost its lock');
  });
}

test('R2: a live owner and 12 simultaneous starters — all starters refused, the owner never loses its lock', { timeout: 120000 }, async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const owner = await acquireDirectoryLock(dir); await owner.ready;
  const outs = await race(dir, 12);
  assert.deepEqual(outs, Array(12).fill('REFUSED'));
  owner.assertHeld(); owner.release();
});

// =============================================================== R3: threads and isolates
test('R3: a worker thread in the same process cannot take the lock, before or after the owner is listening', { timeout: 30000 }, async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tryFromWorker = () => new Promise(resolve => {
    const code = `const { workerData, parentPort } = require('node:worker_threads');
      import(workerData.lock).then(async ({ acquireDirectoryLock }) => { try { const h = await acquireDirectoryLock(workerData.dir); parentPort.postMessage('ACQUIRED'); h.release(); }
      catch (e) { parentPort.postMessage(e.code === 'DATA_DIRECTORY_LOCKED' ? 'REFUSED' : 'ERROR ' + e.message); } });`;
    const w = new Worker(code, { eval: true, workerData: { lock: path.join(root, 'server/lock.js'), dir } });
    w.on('message', resolve); w.on('error', e => resolve('ERROR ' + e.message)); w.on('exit', () => resolve('ERROR worker exited without answering'));
  });
  // (a) immediately after a synchronous first write: the owner's liveness endpoint may not be listening yet.
  const s = new Store(dir); s.transaction(st => { st.sessions.x = { n: 1 }; });
  const tokenBefore = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')).token;
  assert.equal(await tryFromWorker(), 'REFUSED');
  // (b) once the owner is fully established.
  await s.lock.ready; assert.equal(await tryFromWorker(), 'REFUSED');
  assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')).token, tokenBefore);
  s.transaction(st => { st.sessions.x.n = 2; }); // the owner keeps writing
  assert.equal(new Store(dir).get('x').n, 2);
  s.release();
});

// =============================================================== R1: PID equality, PID reuse, PID namespaces
test('R1: a lock carrying this process\'s PID but an unknown token is never taken over', async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bootId = (() => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } })();
  const pidNs = (() => { try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return null; } })();
  const foreign = { version: 2, pid: process.pid, hostname: os.hostname(), bootId, pidNs, token: randomUUID(), startedAt: new Date().toISOString() };
  fs.writeFileSync(lockFile(dir), JSON.stringify(foreign));
  await assert.rejects(acquireDirectoryLock(dir), e => e.code === 'DATA_DIRECTORY_LOCKED');
  assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')).token, foreign.token); // untouched
});

test('R1: a lock whose PID belongs to an unrelated live process (PID reuse) is refused, never removed', async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sleeper = track(spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']));
  const bootId = (() => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } })();
  const pidNs = (() => { try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return null; } })();
  const lock = { version: 2, pid: sleeper.pid, hostname: os.hostname(), bootId, pidNs, token: randomUUID(), startedAt: new Date().toISOString() };
  fs.writeFileSync(lockFile(dir), JSON.stringify(lock));
  await assert.rejects(acquireDirectoryLock(dir), e => e.code === 'DATA_DIRECTORY_LOCKED');
  assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')).token, lock.token);
  sleeper.kill('SIGKILL');
});

let nextPort = 23000 + Math.floor(Math.random() * 15000);
function launch(dir, { isolate = false } = {}) {
  const port = nextPort++, args = ['server/index.js'];
  const p = track(spawn(isolate ? 'unshare' : process.execPath, isolate ? ['--pid', '--fork', '--mount-proc', process.execPath, ...args] : args, { cwd: root, env: { ...process.env, PORT: String(port), CARGO_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] }));
  let out = ''; const outcome = new Promise(resolve => {
    p.stdout.on('data', d => { out += d; if (out.includes('Cargo is ready')) resolve({ ready: true }); });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => resolve({ ready: false, code }));
    setTimeout(() => resolve({ ready: false, code: 'timeout' }), 20000);
  });
  const stop = async (signal = 'SIGTERM') => { for (const d of descendants(p.pid)) try { process.kill(d, signal); } catch {} try { p.kill(signal); } catch {} await exited(p); };
  return { p, url: 'http://127.0.0.1:' + port, outcome, output: () => out, stop };
}
async function placeBet(url) {
  const s = await fetch(url + '/api/session'); const cookie = s.headers.get('set-cookie').split(';')[0], snap = await s.json();
  const r = await fetch(url + '/api/rounds', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: url }, body: JSON.stringify({ difficulty: 'easy', stakeCents: 3000, clientSeed: 'p4a1', expectedSeedHash: snap.session.nextSeedHash, revision: 0, actionId: 'p4a1-' + randomUUID().slice(0, 8) }) });
  return { cookie, id: /cargo_session=([a-f0-9]{64})/.exec(cookie)[1], status: r.status, body: await r.json() };
}

test('R1: servers in separate PID namespaces sharing the folder are refused; the owner keeps writing', { skip: !canUnshare && 'UNVERIFIED: PID namespaces (unshare) unavailable on this platform', timeout: 120000 }, async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = launch(dir); assert.equal((await A.outcome).ready, true);
  const bet = await placeBet(A.url); assert.equal(bet.status, 200);
  for (let i = 0; i < 2; i++) {
    const B = launch(dir, { isolate: true }); const rb = await B.outcome;
    if (rb.ready) await B.stop('SIGKILL');
    assert.equal(rb.ready, false, 'a namespaced server must not start: ' + B.output());
    assert.match(B.output(), /already running/i);
  }
  const st = await (await fetch(A.url + '/api/session', { headers: { Cookie: bet.cookie } })).json();
  const w = await fetch(A.url + '/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: bet.cookie, Origin: A.url }, body: JSON.stringify({ revision: st.session.revision, actionId: 'p4a1-ns-write' }) });
  assert.equal(w.status, 409); // an active round: the request reaches the engine (not 500/503), so A still owns the folder
  A.p.kill('SIGTERM'); await exited(A.p);
});

test('R1: an owner that crashed inside a PID namespace is recovered by a later start on the host', { skip: !canUnshare && 'UNVERIFIED: PID namespaces (unshare) unavailable on this platform', timeout: 120000 }, async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await crashOwner(dir, { isolate: true });
  const h = await acquireDirectoryLock(dir); await h.ready; h.assertHeld(); h.release();
});

// =============================================================== termination, recovery, release
test('termination: after SIGKILL the next start recovers automatically and acknowledged data is intact', { timeout: 120000 }, async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = launch(dir); assert.equal((await A.outcome).ready, true);
  const bet = await placeBet(A.url); assert.equal(bet.status, 200);
  A.p.kill('SIGKILL'); await exited(A.p);
  const B = launch(dir); assert.equal((await B.outcome).ready, true, B.output());
  const r = await (await fetch(B.url + '/api/session', { headers: { Cookie: bet.cookie } })).json();
  assert.equal(r.session.balanceCents, 97000); assert.equal(r.round.status, 'active');
  B.p.kill('SIGTERM'); await exited(B.p);
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith('state.lock')), []); // graceful exit leaves no lock files
});

test('release never deletes another owner\'s lock', async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = await acquireDirectoryLock(dir); await h.ready;
  const foreign = { ...JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')), token: randomUUID() };
  fs.writeFileSync(lockFile(dir), JSON.stringify(foreign));
  assert.throws(() => h.assertHeld(), e => e.code === 'OWNERSHIP_LOST' || e.code === 'DATA_DIRECTORY_LOCKED');
  h.release();
  assert.equal(JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')).token, foreign.token);
});

test('fail closed: an unreadable or truncated lock is refused regardless of its age, with manual instructions', async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const content of ['', '{"pid":', 'null']) {
    fs.writeFileSync(lockFile(dir), content); const old = new Date(Date.now() - 3600000); fs.utimesSync(lockFile(dir), old, old);
    await assert.rejects(acquireDirectoryLock(dir), e => e.code === 'DATA_DIRECTORY_LOCKED' && e.message.includes(lockFile(dir)));
    assert.equal(fs.readFileSync(lockFile(dir), 'utf8'), content);
  }
});

test('fail closed: a recovery left unfinished by a crash blocks startup with a clear manual-recovery message', async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await crashOwner(dir);
  fs.writeFileSync(path.join(dir, 'state.lock.recover'), JSON.stringify({ pid: 999999, token: randomUUID() }));
  await assert.rejects(acquireDirectoryLock(dir), e => e.code === 'DATA_DIRECTORY_LOCKED' && e.message.includes('state.lock.recover'));
  fs.rmSync(path.join(dir, 'state.lock.recover'));
  const h = await acquireDirectoryLock(dir); h.release(); // after deliberate manual removal, recovery proceeds
});

// =============================================================== R4: lost ownership
test('R4: a server that loses ownership stops serving state (503, no stale reads), exits, and keeps acknowledged data', { timeout: 120000 }, async t => {
  for (const loss of ['lock replaced', 'liveness endpoint removed']) {
    const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const A = launch(dir); assert.equal((await A.outcome).ready, true);
    const bet = await placeBet(A.url); assert.equal(bet.status, 200);
    const onDisk = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    if (loss === 'lock replaced') fs.writeFileSync(lockFile(dir), JSON.stringify({ ...JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')), token: randomUUID() }));
    else { const socks = fs.readdirSync(dir).filter(f => f.endsWith('.sock')); assert.equal(socks.length, 1, loss); fs.rmSync(path.join(dir, socks[0])); }
    const read = await fetch(A.url + '/api/session', { headers: { Cookie: bet.cookie } }).catch(() => null);
    if (read) { assert.equal(read.status, 503, loss); const b = await read.json(); assert.equal(b.code, 'SERVER_UNAVAILABLE'); assert.equal(b.session, undefined); }
    await waitFor(() => A.p.exitCode !== null || A.p.signalCode !== null, 10000);
    assert.equal(A.p.exitCode, 1, loss);
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), onDisk, loss); // nothing written after the loss
    const saved = JSON.parse(onDisk).sessions[bet.id]; assert.equal(saved.balanceCents, 97000); // acknowledged bet preserved
  }
});

test('R4: an in-process Store that lost ownership refuses reads and writes', async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new Store(dir); s.transaction(st => { st.sessions.x = { n: 1 }; }); await s.lock.ready;
  fs.writeFileSync(lockFile(dir), JSON.stringify({ ...JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')), token: randomUUID() }));
  assert.throws(() => s.get('x'), e => e.code === 'OWNERSHIP_LOST');
  assert.throws(() => s.transaction(st => { st.sessions.x.n = 2; }), e => e.code === 'OWNERSHIP_LOST');
  assert.equal(new Store(dir).get('x').n, 1);
});

test('defence in depth: each owner writes through its own temporary file; leftovers are removed on acquisition', async t => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'state.json.tmp'), 'stale'); fs.writeFileSync(path.join(dir, 'state.json.0123456789ab.tmp'), 'stale');
  const s = new Store(dir); await Promise.resolve().then(() => s.acquire());
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
  const seen = []; const original = fs.writeFileSync;
  fs.writeFileSync = function (file, ...rest) { seen.push(path.basename(String(file))); return original.call(this, file, ...rest); };
  try { s.transaction(st => { st.sessions.y = {}; }); } finally { fs.writeFileSync = original; }
  assert.ok(seen.some(f => /^state\.json\.[0-9a-f]{12}\.tmp$/.test(f)), JSON.stringify(seen));
  s.release();
});

// =============================================================== P3-01: bounded property test
test('P3-01 property: the depth limit matches true JSON depth for random documents; malformed input is always 400', () => {
  let seed = 4242; const rnd = n => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  const pieces = ['[', ']', '{', '}', '"', '\\', '\\"', '\\\\', ' ', '🚢', ':', ','];
  const str = () => Array.from({ length: rnd(6) }, () => pieces[rnd(pieces.length)]).join('');
  const gen = d => d === 0 ? [str(), rnd(9), null, true][rnd(4)] : (rnd(2) ? [gen(d - 1), gen(Math.min(rnd(d), 2))] : { [str() + 'a']: gen(d - 1), [str() + 'b']: gen(Math.min(rnd(d), 2)) });
  const depth = v => v && typeof v === 'object' ? 1 + Math.max(0, ...Object.values(v).map(depth)) : 0;
  const enc = s => new TextEncoder().encode(s);
  for (let i = 0; i < 1500; i++) {
    const doc = { root: gen(rnd(45)) }, d = depth(doc), text = rnd(3) ? JSON.stringify(doc) : JSON.stringify(doc, null, 1);
    if (d > MAX_JSON_DEPTH) assert.throws(() => parseJsonObject(enc(text)), e => e.status === 400 && e.code === 'JSON_TOO_DEEP', `depth ${d}`);
    else assert.deepEqual(parseJsonObject(enc(text)), JSON.parse(text), `depth ${d}`);
  }
  for (let i = 0; i < 1500; i++) {
    let t = JSON.stringify({ a: gen(rnd(36)) }); const c = rnd(t.length);
    t = [t.slice(0, c), t.slice(0, c) + ']'.repeat(rnd(40)) + t.slice(c), ']'.repeat(rnd(50)) + '['.repeat(rnd(50)) + t][rnd(3)];
    try { parseJsonObject(enc(t)); } catch (e) { assert.equal(e.status, 400); }
  }
});
