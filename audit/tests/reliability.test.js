// Phase-3 reliability and state-integrity tests (non-production, synthetic data, test-only fixtures).
// See CARGO_PHASE3_RELIABILITY_REPORT.md. Run: node --test audit/tests/*.test.js
//
// Tests named "KNOWN DEFECT" characterise current, unfixed behaviour and will fail on purpose
// once the defect is fixed (then move them to a protective test). All other tests assert
// properties that must keep holding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS, localAdapter, workerAdapter, aid, startSession, bet, act, ledgerInvariant } from '../lib/harness.mjs';
import { loadEngineVariant } from '../lib/engine-variant.mjs';
import { Store } from '../../server/store.js';
import { createApp } from '../../server/app.js';
import { MODES } from '../../public/math.js';
import { verifyRound } from '../../public/fairness.js';
import { splitmix } from '../lib/seeds.mjs';

const safe = { A: [20], B: [20], C: [20] };
const force = (c, h) => c.mutate(s => { s.rounds[s.currentRoundId].hazards = h; });
const settle = async (c, id) => { let st = (await c.get('/api/session')).body; while (st.round?.id === id && st.round.status === 'active') st = (st.round.step === st.round.maxStops || st.round.step >= 1 ? await act(c, `/api/rounds/${id}/collect`, { containerId: 'all' }) : await act(c, `/api/rounds/${id}/advance`)).body; return st; };
function roundInvariants(session) {
  for (const r of Object.values(session.rounds)) {
    assert.equal(r.status === 'settled', r.containers.every(c => c.status !== 'onboard'), 'settled iff nothing onboard');
    for (const c of r.containers) if (c.status !== 'collected') assert.equal(c.payoutCents, 0);
  }
  const active = Object.values(session.rounds).filter(r => r.status === 'active');
  assert.ok(active.length <= 1, 'at most one active round');
  if (active.length) assert.equal(session.currentRoundId, active[0].id);
}

// ------------------------------------------------------------ 1. persistence and recovery (local store)
test('local restart: an active round, the wallet and idempotency receipts survive a server restart', async t => {
  const a = await localAdapter(); const c = a.client();
  const b = await bet(c, { stakeCents: 3001 }); await force(c, safe);
  const advBody = { revision: b.body.session.revision, actionId: aid('pre-restart') };
  assert.equal((await c.post(`/api/rounds/${b.body.round.id}/advance`, advBody)).status, 200);
  const before = structuredClone(c.raw());
  await new Promise(r => a.app.close(r));
  // Restart: a fresh Store and HTTP server over the same directory, same cookie.
  const store = new Store(a.directory), app = createApp(store); await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => app.close(r)); fs.rmSync(a.directory, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + app.address().port, cookie = c.jar.header();
  const post = async (p, body) => { const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: url }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const restored = await (await fetch(url + '/api/session', { headers: { Cookie: cookie } })).json();
  assert.deepEqual(store.get(c.jar.id()), before);
  assert.equal(restored.round.status, 'active'); assert.equal(restored.round.step, 1);
  const replay = await post(`/api/rounds/${b.body.round.id}/advance`, advBody);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.round.step, 1);
  const col = await post(`/api/rounds/${b.body.round.id}/collect`, { revision: restored.session.revision, actionId: aid('post-restart'), containerId: 'all' });
  assert.equal(col.status, 200); assert.equal(col.body.round.status, 'settled');
  assert.ok(ledgerInvariant(store.get(c.jar.id())).ok);
});

test('local restart: a stale state.json.tmp left by an interrupted write is ignored and overwritten', async t => {
  const a = await localAdapter(); const c = a.client(); await bet(c);
  const committed = fs.readFileSync(path.join(a.directory, 'state.json'), 'utf8');
  await new Promise(r => a.app.close(r));
  fs.writeFileSync(path.join(a.directory, 'state.json.tmp'), '{"version":1,"sessions":{"garbage');
  const store = new Store(a.directory); t.after(() => fs.rmSync(a.directory, { recursive: true, force: true }));
  assert.equal(JSON.stringify(store.state), committed);
  store.transaction(st => { st.sessions[c.jar.id()].note = 'x'; });
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.directory, 'state.json'), 'utf8')).sessions[c.jar.id()].note, 'x');
});

test('local restart: a truncated or empty state.json makes startup fail closed (no silent wallet reset)', async t => {
  const a = await localAdapter(); const c = a.client(); await bet(c);
  await new Promise(r => a.app.close(r)); t.after(() => fs.rmSync(a.directory, { recursive: true, force: true }));
  const file = path.join(a.directory, 'state.json'), good = fs.readFileSync(file, 'utf8');
  for (const broken of [good.slice(0, Math.floor(good.length / 2)), '', '{"version":2,"sessions":{}}']) {
    fs.writeFileSync(file, broken);
    assert.throws(() => new Store(a.directory));
  }
  fs.writeFileSync(file, good); assert.ok(new Store(a.directory).get(c.jar.id()));
});

// ------------------------------------------------------------ 2. concurrency
for (const [kind, make] of Object.entries(ADAPTERS)) {
  test(`${kind}: 8 sessions playing concurrently stay isolated and individually consistent`, async t => {
    const a = await make(); t.after(() => a.close());
    const clients = Array.from({ length: 8 }, () => a.client());
    await Promise.all(clients.map(async (c, i) => {
      const rng = splitmix(`p3-concurrent|${kind}|${i}`); await startSession(c);
      for (let k = 0; k < 10; k++) {
        const b = await bet(c, { difficulty: rng.pick(Object.keys(MODES)), stakeCents: 300 + rng.int(3000), clientSeed: `iso-${i}-${k}` });
        assert.equal(b.status, 200);
        await settle(c, b.body.round.id);
      }
    }));
    const ids = clients.map(c => c.jar.id());
    assert.equal(new Set(ids).size, 8);
    for (const c of clients) {
      const s = c.raw(); assert.ok(ledgerInvariant(s).ok); roundInvariants(s);
      assert.equal(Object.keys(s.rounds).length, 10);
      assert.ok(s.ledger.every(e => e.roundId === null || s.rounds[e.roundId]), 'ledger refers only to own rounds');
    }
  });

  test(`${kind}: a reset racing a bet at the same revision — exactly one wins and state stays consistent`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client();
    for (let i = 0; i < 10; i++) {
      const s = (await c.get('/api/session')).body;
      const rs = await Promise.all([
        c.post('/api/reset', { revision: s.session.revision, actionId: aid('rr') }),
        c.post('/api/rounds', { difficulty: 'easy', stakeCents: 300, clientSeed: 'r', expectedSeedHash: s.session.nextSeedHash, revision: s.session.revision, actionId: aid('rb') })]);
      assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
      const st = (await c.get('/api/session')).body; if (st.round?.status === 'active') await settle(c, st.round.id);
    }
    assert.ok(ledgerInvariant(c.raw()).ok); roundInvariants(c.raw());
  });

  // ---------------------------------------------------------- 3. duplicate and reordered requests
  test(`${kind}: out-of-order delivery is rejected as stale, then applies correctly in order`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client();
    const b = await bet(c); await force(c, safe); const rev = b.body.session.revision, id = b.body.round.id;
    const advance = { revision: rev, actionId: aid('o-adv') }, collect = { revision: rev + 1, actionId: aid('o-col'), containerId: 'all' };
    const early = await c.post(`/api/rounds/${id}/collect`, collect);
    assert.equal(early.status, 409); assert.equal(early.body.code, 'STALE_REVISION');
    assert.equal(c.raw().rounds[id].step, 0);
    assert.equal((await c.post(`/api/rounds/${id}/advance`, advance)).status, 200);
    const late = await c.post(`/api/rounds/${id}/collect`, collect); // now in order
    assert.equal(late.status, 200); assert.equal(late.body.round.status, 'settled');
    assert.equal((await c.post(`/api/rounds/${id}/advance`, advance)).body.replayed, true); // late duplicate of the first
    assert.ok(ledgerInvariant(c.raw()).ok);
  });

  test(`${kind}: a very late duplicate of a bet replays without a new debit, even after later rounds`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client();
    const s = await startSession(c), first = { difficulty: 'easy', stakeCents: 300, clientSeed: 'late', expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('late-bet') };
    const r1 = await c.post('/api/rounds', first); await settle(c, r1.body.round.id);
    const r2 = await bet(c); await settle(c, r2.body.round.id);
    const ledgerBefore = c.raw().ledger.length;
    const dup = await c.post('/api/rounds', first);
    assert.equal(dup.status, 200); assert.equal(dup.body.replayed, true);
    assert.equal(c.raw().ledger.length, ledgerBefore);
    // Documented contract: a replay returns the LATEST snapshot, not the original response.
    assert.equal(dup.body.round.id, r2.body.round.id);
  });

  test(`${kind}: the same action ID in two different sessions is independent`, async t => {
    const a = await make(); t.after(() => a.close()); const c1 = a.client(), c2 = a.client();
    await startSession(c1); await startSession(c2);
    const body = { revision: 0, actionId: 'shared-id-0001' };
    assert.equal((await c1.post('/api/reset', body)).body.replayed, undefined);
    assert.equal((await c2.post('/api/reset', body)).body.replayed, undefined);
  });

  // ---------------------------------------------------------- 5. invalid input (deterministic fuzz)
  test(`${kind}: 400 deterministic malformed requests never return 500 and never change state unless accepted`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client(); await startSession(c);
    const rng = splitmix('p3-fuzz|' + kind);
    const scalars = [null, true, false, 0, -1, 1.5, 300, 3000, 2 ** 53, -0, '', 'easy', 'all', 'A', 'constructor', '__proto__', 'x'.repeat(200), '🚢', '\u0000', [], {}];
    const keys = ['actionId', 'revision', 'difficulty', 'stakeCents', 'clientSeed', 'expectedSeedHash', 'containerId', '__proto__', 'constructor', 'extra'];
    const value = (d = 0) => { const k = rng.int(10); if (d < 4 && k === 0) return Array.from({ length: rng.int(4) }, () => value(d + 1)); if (d < 4 && k === 1) return obj(d + 1); return rng.pick(scalars); };
    const obj = (d = 0) => Object.fromEntries(Array.from({ length: rng.int(6) }, () => [rng.pick(keys), value(d)]));
    const rawCases = ['{"revision":1e309,"actionId":"fuzz-raw-001"}', '{"revision":0,"revision":1,"actionId":"fuzz-raw-002"}', '{"revision":12345678901234567890,"actionId":"fuzz-raw-003"}', ' \n{"revision":0} ', 'null', '"text"', '[]', '{"a":1', '﻿﻿{}', '{"actionId":"fuzz-raw-004","revision":-0}'];
    const statuses = {}; let accepted = 0;
    for (let i = 0; i < 400; i++) {
      const st = (await c.get('/api/session')).body, roundId = st.round?.id || '00000000-0000-4000-8000-000000000000';
      const route = rng.pick(['/api/rounds', '/api/reset', `/api/rounds/${roundId}/advance`, `/api/rounds/${roundId}/collect`, '/api/unknown']);
      let raw;
      if (i < rawCases.length) raw = rawCases[i];
      else { const o = obj(); if (rng.int(3) === 0) { o.actionId = aid('fz'); o.revision = st.session.revision; } if (rng.int(4) === 0) o.expectedSeedHash = st.session.nextSeedHash; raw = JSON.stringify(o); }
      const before = JSON.stringify(c.raw()), r = await c.post(route, null, {}, raw);
      statuses[r.status] = (statuses[r.status] || 0) + 1;
      assert.notEqual(r.status, 500, `${route} ${raw.slice(0, 120)}`);
      if (r.status === 200) accepted++; else assert.equal(JSON.stringify(c.raw()), before, `${r.status} changed state: ${raw.slice(0, 120)}`);
    }
    t.diagnostic(`statuses ${JSON.stringify(statuses)}; accepted ${accepted}`);
    assert.ok(accepted > 0 && Object.keys(statuses).length >= 3, JSON.stringify(statuses));
    assert.ok(ledgerInvariant(c.raw()).ok); roundInvariants(c.raw());
  });

  test(`KNOWN DEFECT P3-01 (${kind}): a deeply nested body inside the size limit returns 500 instead of 400`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client(); const s = await startSession(c);
    const before = JSON.stringify(c.raw()), depth = 5000;
    const r = await c.post('/api/reset', null, {}, `{"revision":${s.session.revision},"actionId":"deep-nest-01","x":${'['.repeat(depth)}${']'.repeat(depth)}}`);
    assert.equal(r.status, 500); assert.equal(r.body.code, 'SERVER_ERROR');
    assert.equal(JSON.stringify(c.raw()), before); // contained: nothing is written
    const shallow = await c.post('/api/reset', null, {}, `{"revision":${s.session.revision},"actionId":"deep-nest-02","x":${'['.repeat(64)}${']'.repeat(64)}}`);
    assert.equal(shallow.status, 200); // ordinary nesting is unaffected
  });

  // ---------------------------------------------------------- 6. session lifecycle
  test(`${kind}: malformed, unknown and duplicated session cookies are handled without cross-session access`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client(); await startSession(c);
    const realId = c.jar.id(), sessionsBefore = a.sessionCount();
    for (const bad of ['cargo_session=' + realId.toUpperCase(), 'cargo_session=' + realId.slice(1), 'cargo_session=' + realId + 'ff', 'cargo_session=../../etc']) {
      const x = a.client(); x.jar.set(bad);
      assert.equal((await x.post('/api/reset', { revision: 0, actionId: aid('mc') })).status, 401, bad);
    }
    const dup = a.client(); dup.jar.set(`cargo_session=${'0'.repeat(64)}; cargo_session=${realId}`);
    assert.equal((await dup.post('/api/reset', { revision: 0, actionId: aid('dc') })).status, 401); // first cookie wins; never falls through to the second
    assert.equal(a.sessionCount(), sessionsBefore);
  });

  test(`KNOWN DEFECT F05/F09 (${kind}): a lost session is replaced silently by a new funded wallet; sessions carry no lifecycle timestamps`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client();
    const b = await bet(c); const lostId = c.jar.id();
    assert.ok(!Object.keys(c.raw()).some(k => /created|seen|expire|updated/i.test(k)));
    // Simulate loss of the stored session (storage cleanup, F07 overwrite, operator deletion).
    if (kind === 'worker') a.sql.prepare('DELETE FROM cargo_sessions WHERE id = ?').run(lostId);
    else delete a.store.state.sessions[lostId];
    assert.equal(c.raw(), null);
    assert.equal((await c.post(`/api/rounds/${b.body.round.id}/advance`, { revision: 1, actionId: aid('gone') })).status, 401);
    const fresh = await c.get('/api/session');
    assert.equal(fresh.status, 200); assert.notEqual(c.jar.id(), lostId);
    assert.equal(fresh.body.session.balanceCents, 100000); assert.equal(fresh.body.round, null); // the debited wager is not surfaced
  });
}

// ------------------------------------------------------------ 4. partial storage failures
test('local: a failed rename after the temp write leaves memory and disk unchanged; the exact retry succeeds once', async t => {
  const a = await localAdapter(); t.after(() => a.close()); const c = a.client(); const s = await startSession(c);
  const before = JSON.stringify(a.store.state), disk = fs.readFileSync(path.join(a.directory, 'state.json'), 'utf8');
  const original = fs.renameSync; let armed = true;
  fs.renameSync = function (...args) { if (armed) { armed = false; throw new Error('injected rename failure'); } return original.apply(this, args); };
  const body = { difficulty: 'easy', stakeCents: 300, clientSeed: 'rn', expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('rename') };
  let first; try { first = await c.post('/api/rounds', body); } finally { fs.renameSync = original; }
  assert.equal(first.status, 500);
  assert.equal(JSON.stringify(a.store.state), before); assert.equal(fs.readFileSync(path.join(a.directory, 'state.json'), 'utf8'), disk);
  const retry = await c.post('/api/rounds', body);
  assert.equal(retry.status, 200); assert.equal(retry.body.replayed, undefined); assert.equal(c.raw().ledger.length, 1);
});

test('worker: read failure, session-insert failure and post-commit failure on collect are all safe', async t => {
  const a = await workerAdapter(); t.after(() => a.close());
  a.faults.beforeInsert = 1; const anon = a.client();
  const noSession = await anon.get('/api/session');
  assert.equal(noSession.status, 500); assert.equal(anon.jar.id(), undefined); assert.equal(a.sessionCount(), 0); // no cookie for a session that was not stored
  const c = a.client(); const b = await bet(c); await force(c, safe);
  const adv = await act(c, `/api/rounds/${b.body.round.id}/advance`);
  a.faults.beforeRead = 1; const before = JSON.stringify(c.raw());
  const readFail = await c.post(`/api/rounds/${b.body.round.id}/collect`, { revision: adv.body.session.revision, actionId: aid('rf'), containerId: 'all' });
  assert.equal(readFail.status, 500); assert.equal(JSON.stringify(c.raw()), before);
  const body = { revision: adv.body.session.revision, actionId: aid('pc'), containerId: 'all' };
  a.faults.afterUpdate = 1;
  assert.equal((await c.post(`/api/rounds/${b.body.round.id}/collect`, body)).status, 500); // committed, response lost
  const retry = await c.post(`/api/rounds/${b.body.round.id}/collect`, body);
  assert.equal(retry.status, 200); assert.equal(retry.body.replayed, true);
  assert.equal(c.raw().ledger.filter(e => e.kind === 'collect').length, 3); assert.ok(ledgerInvariant(c.raw()).ok);
});

// ------------------------------------------------------------ 7. configuration version consistency (F11)
test('KNOWN DEFECT F11: after a payout-table deployment, previously valid proofs fail verification and history shows the new multiplier', async t => {
  const a = await workerAdapter(); t.after(() => a.close()); const c = a.client(); await startSession(c);
  // A natural (unforced) round in which all three containers are collected at stop 1, so its proof is genuine.
  let natural;
  for (let i = 0; i < 20 && !natural; i++) {
    const r = await bet(c, { clientSeed: 'nat-' + i }); const id = r.body.round.id;
    const st = (await act(c, `/api/rounds/${id}/advance`)).body;
    if (st.round.status === 'active') { await act(c, `/api/rounds/${id}/collect`, { containerId: 'all' }); if (c.raw().rounds[id].containers.every(x => x.collectedAt === 1)) natural = id; }
  }
  assert.ok(natural);
  const proof = (await c.get('/api/rounds/' + natural)).body.round;
  assert.equal((await verifyRound(proof)).valid, true);
  const next = await loadEngineVariant(text => text.replace('1, [103,109,', '1, [104,109,'));
  a.useWorker(next.worker);
  const reprojected = (await c.get('/api/rounds/' + natural)).body.round;
  assert.equal(reprojected.multiplier100, 104); assert.equal(proof.multiplier100, 103);
  assert.equal((await next.verifier.verifyRound(proof)).valid, false); // the original export no longer verifies
  assert.equal((await next.verifier.verifyRound(reprojected)).valid, false); // nor does the re-projected one
});

test('KNOWN DEFECT F11: a deployment that shortens a mode makes an active round unsettleable and the whole session unreadable', async t => {
  const a = await workerAdapter(); t.after(() => a.close()); const c = a.client();
  const b = await bet(c, { difficulty: 'expert' }); await force(c, safe);
  for (let i = 0; i < 10; i++) await act(c, `/api/rounds/${b.body.round.id}/advance`);
  const next = await loadEngineVariant(text => text.replace(',1646008,18106088])', ',1646008])'));
  a.useWorker(next.worker);
  const read = await c.get('/api/session');
  assert.equal(read.status, 500); // snapshot() → publicRound() → payout(stake, undefined) throws
  const collect = await c.post(`/api/rounds/${b.body.round.id}/collect`, { revision: 11, actionId: aid('short'), containerId: 'all' });
  assert.equal(collect.status, 500);
  assert.equal(c.raw().rounds[b.body.round.id].status, 'active'); // the wager remains stranded
});
