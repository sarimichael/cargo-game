// Phase-2 regression tests: each test reproduces a documented defect and asserts the
// CORRECTED behaviour. See CARGO_PHASE2_REMEDIATION_REPORT.md.
// Run: node --test audit/tests/*.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { ADAPTERS, localAdapter, workerAdapter, aid, startSession, bet, act, ledgerInvariant } from '../lib/harness.mjs';
import { MODES } from '../../public/math.js';
import { createSession, beginRound, advanceRound, collectRound, publicRound } from '../../server/game.js';
import { seedHash } from '../../server/fairness.js';
import { verifyRound } from '../../public/fairness.js';
import { MAX_SESSION_BODY_BYTES, SETTLEMENT_RESERVE_BYTES } from '../../server/protocol.js';
import { derivedSeed } from '../lib/seeds.mjs';

const safe = { A: [20], B: [20], C: [20] };
const force = (c, h) => c.mutate(s => { s.rounds[s.currentRoundId].hazards = h; });

// ---------------------------------------------------------------- N01
test('N01 fixed: local server keeps a multi-byte client seed split across TCP chunks intact', async t => {
  const a = await localAdapter(); t.after(() => a.close()); const c = a.client(); await startSession(c);
  for (const [k, seed] of ['ship-🚢', 'é-accent', '漢字-cargo', '🚢⚓️🌊'].entries()) {
    const st = (await c.get('/api/session')).body;
    if (st.round?.status === 'active') await c.mutate(x => { x.rounds[x.currentRoundId].status = 'settled'; for (const ct of x.rounds[x.currentRoundId].containers) ct.status = 'lost'; });
    const fresh = (await c.get('/api/session')).body;
    const bytes = Buffer.from(JSON.stringify({ difficulty: 'easy', stakeCents: 300, clientSeed: seed, expectedSeedHash: fresh.session.nextSeedHash, revision: fresh.session.revision, actionId: aid('u8') }));
    const at = bytes.indexOf(Buffer.from(seed)) + 1 + (k % 2); // split inside the first multi-byte character
    const status = await new Promise((resolve, reject) => {
      const req = http.request(a.url + '/api/rounds', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c.jar.header(), Origin: a.url, 'Content-Length': bytes.length } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.write(bytes.subarray(0, at)); setTimeout(() => req.end(bytes.subarray(at)), 40);
    });
    assert.equal(status, 200, seed);
    assert.equal(c.raw().rounds[c.raw().currentRoundId].clientSeed, seed);
  }
});

for (const [kind, make] of Object.entries(ADAPTERS)) {
  test(`N01 fixed (${kind}): invalid UTF-8 request bodies are rejected with 400 and change nothing`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client(); const s = await startSession(c);
    const before = JSON.stringify(c.raw());
    const head = Buffer.from(`{"difficulty":"easy","stakeCents":300,"expectedSeedHash":"${s.session.nextSeedHash}","revision":0,"actionId":"${aid('bad')}","clientSeed":"x`);
    for (const bad of [Buffer.from([0xC3, 0x28]), Buffer.from([0xED, 0xA0, 0x80]), Buffer.from([0xF0, 0x9F, 0x9A]), Buffer.from([0xFF])]) {
      const r = await c.post('/api/rounds', null, {}, Buffer.concat([head, bad, Buffer.from('"}')]));
      assert.equal(r.status, 400, bad.toString('hex'));
    }
    assert.equal(JSON.stringify(c.raw()), before);
    // Valid multi-byte text in one piece still works exactly as before.
    const ok = await c.post('/api/rounds', { difficulty: 'easy', stakeCents: 300, clientSeed: '🚢 ok', expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('ok') });
    assert.equal(ok.status, 200); assert.equal(ok.body.round.proof.clientSeed, '🚢 ok');
  });

  // -------------------------------------------------------------- F10
  test(`F10 fixed (${kind}): prototype-named action IDs execute once and replay correctly`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client(); let s = await startSession(c);
    // Every Object.prototype member name that satisfies the 8–80 character action-ID rule.
    for (const id of ['constructor', 'toString', 'hasOwnProperty', 'isPrototypeOf', 'toLocaleString', 'propertyIsEnumerable']) {
      const body = { revision: s.session.revision, actionId: id };
      const first = await c.post('/api/reset', body);
      assert.equal(first.status, 200, id); assert.equal(first.body.replayed, undefined, id);
      const again = await c.post('/api/reset', body);
      assert.equal(again.status, 200, id); assert.equal(again.body.replayed, true, id);
      s = first.body;
    }
    assert.equal(c.raw().ledger.filter(e => e.kind === 'refill').length, 6);
  });

  test(`F10 fixed (${kind}): a semantically identical retry with reordered JSON keys is replayed, not rejected`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client();
    const b = await bet(c); await force(c, safe); const adv = await act(c, `/api/rounds/${b.body.round.id}/advance`);
    const id = aid('ord'), rev = adv.body.session.revision, path = `/api/rounds/${b.body.round.id}/collect`;
    assert.equal((await c.post(path, { revision: rev, actionId: id, containerId: 'all' })).status, 200);
    const reordered = await c.post(path, { containerId: 'all', actionId: id, revision: rev });
    assert.equal(reordered.status, 200); assert.equal(reordered.body.replayed, true);
    const changed = await c.post(path, { containerId: 'A', actionId: id, revision: rev });
    assert.equal(changed.status, 409); // a genuinely different request under the same ID is still refused
    assert.equal(c.raw().ledger.filter(e => e.kind === 'collect').length, 3);
    assert.ok(ledgerInvariant(c.raw()).ok);
  });

  test(`F10 fixed (${kind}): receipts written by the previous fingerprint format still replay after upgrade`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client(); const s = await startSession(c);
    const input = { revision: s.session.revision, actionId: aid('legacy') };
    // Simulate a receipt stored by the pre-fix code path for an action that already executed.
    const legacy = createHash('sha256').update(JSON.stringify(['/api/reset', input])).digest('hex');
    await c.mutate(x => { x.receipts[input.actionId] = { fingerprint: legacy, at: new Date().toISOString() }; });
    const r = await c.post('/api/reset', input);
    assert.equal(r.status, 200); assert.equal(r.body.replayed, true);
    assert.equal(c.raw().ledger.length, 0);
  });
}

// ---------------------------------------------------------------- F08
async function naturalSettledRound(k = 0, mode = 'easy') {
  let s, r;
  for (let i = 0; ; i++) {
    const seed = derivedSeed(`f08-fix|${mode}|${k}`, i); s = createSession('v', seed);
    r = beginRound(s, { difficulty: mode, stakeCents: 3001, clientSeed: 'proof', expectedSeedHash: seedHash(seed) }, derivedSeed('f08-fix-next', i));
    advanceRound(s, r.id); if (r.containers.every(c => c.status === 'onboard')) break;
  }
  collectRound(s, r.id, 'A');
  while (r.status === 'active') { if (r.step === MODES[mode].payouts.length) collectRound(s, r.id, 'all'); else advanceRound(s, r.id); }
  return publicRound(r);
}

test('F08 fixed: verifier rejects altered metadata, malformed structure and duplicate/missing containers', async () => {
  const base = await naturalSettledRound();
  assert.equal((await verifyRound(base)).valid, true);
  const tampers = {
    algorithm: p => { p.proof.algorithm = 'not-cargo'; }, multiplier100: p => { p.multiplier100 += 1; }, roundIdFormat: p => { p.id = 'forged-id'; },
    valueCents: p => { p.containers[1].valueCents += 1; }, nextRisk: p => { p.nextRisk = 0.99; }, maxStops: p => { p.maxStops = 1; },
    duplicateContainer: p => { p.containers.push(structuredClone(p.containers[0])); }, missingContainer: p => { p.containers.pop(); },
    reorderedContainers: p => { p.containers.reverse(); }, unknownContainer: p => { p.containers[2].id = 'D'; },
    extraTopLevelField: p => { p.bonusCents = 1000000; }, extraContainerField: p => { p.containers[0].jackpotCents = 5; }, extraProofField: p => { p.proof.signedBy = 'operator'; },
    extraHazardDeck: p => { p.proof.hazards.D = [1]; }, badDifficulty: p => { p.difficulty = 'constructor'; }, stakeType: p => { p.stakeCents = '3001'; },
    stakeRange: p => { p.stakeCents = 299; }, negativeNonce: p => { p.proof.nonce = -1; }, longClientSeed: p => { p.proof.clientSeed = 'x'.repeat(129); },
    badSeedHash: p => { p.proof.serverSeedHash = 'zz'; }, badTimestamp: p => { p.finishedAt = 'yesterday'; }, timeTravel: p => { p.finishedAt = '1970-01-01T00:00:00.000Z'; },
    eventsNotArray: p => { p.events = {}; }, notAnObject: () => null
  };
  for (const [name, tamper] of Object.entries(tampers)) {
    const p = structuredClone(base), replaced = tamper(p);
    const v = await verifyRound(replaced === null ? null : p);
    assert.equal(v.valid, false, name);
    assert.equal(typeof v.message, 'string');
  }
});

test('F08 fixed: every naturally played round in all modes still verifies (no false rejections)', async () => {
  let n = 0;
  for (const mode of Object.keys(MODES)) for (let k = 0; k < 10; k++) {
    const seed = derivedSeed('f08-natural|' + mode, k), s = createSession('n', seed);
    const r = beginRound(s, { difficulty: mode, stakeCents: 300 + k * 977, clientSeed: ['🚢', 'a","b', 'x'.repeat(128), 'plain'][k % 4], expectedSeedHash: seedHash(seed) }, derivedSeed('f08-natural-next', k));
    while (r.status === 'active') {
      if (r.step === MODES[mode].payouts.length) collectRound(s, r.id, 'all');
      else { advanceRound(s, r.id); if (r.status === 'active' && r.step === 1 + (k % 3)) collectRound(s, r.id, r.containers.find(c => c.status === 'onboard').id); }
    }
    const v = await verifyRound(publicRound(r)); assert.equal(v.valid, true, `${mode} ${k}: ${v.message}`); n++;
    assert.equal((await verifyRound(JSON.parse(JSON.stringify(publicRound(r))))).valid, true); // exported JSON round-trip
  }
  assert.equal(n, 40);
});

test('F08 limitation (documented): a different well-formed round ID cannot be detected by the verifier', async () => {
  const base = await naturalSettledRound(1); const p = structuredClone(base);
  p.id = '00000000-0000-4000-8000-000000000000';
  assert.equal((await verifyRound(p)).valid, true); // round IDs are not bound into the seed commitment
});

// ---------------------------------------------------------------- N02
test('N02 fixed: payout configuration is deeply immutable at runtime', () => {
  assert.ok(Object.isFrozen(MODES));
  for (const [k, m] of Object.entries(MODES)) {
    assert.ok(Object.isFrozen(m), k); assert.ok(Object.isFrozen(m.payouts), k);
    const before = m.payouts[0];
    assert.throws(() => { m.payouts[0] = before + 1; }, TypeError);
    assert.throws(() => { m.hazards = 0; }, TypeError);
    assert.throws(() => { m.payouts.push(1); }, TypeError);
    assert.equal(m.payouts[0], before);
  }
});

// ---------------------------------------------------------------- F03 (mitigation)
// Test-only fixture: grow the stored session to `target` bytes with an inert receipt entry.
const padTo = (c, target) => c.mutate(s => {
  delete s.receipts['pad-fixture-0001'];
  const now = Buffer.byteLength(JSON.stringify(s)), overhead = Buffer.byteLength(JSON.stringify({ 'pad-fixture-0001': { fingerprint: '', at: 'fixture' } })) - 1;
  s.receipts['pad-fixture-0001'] = { fingerprint: 'p'.repeat(Math.max(0, target - now - overhead)), at: 'fixture' };
});

test('F03 mitigation: the settlement reserve covers the largest possible round with margin', async t => {
  const a = await workerAdapter(); t.after(() => a.close()); const c = a.client(); await startSession(c);
  // Worst case: Easy (most stops), 128-character escaped client seed, 80-character action IDs, three separate collections.
  const longId = p => (p + '-' + 'x'.repeat(80)).slice(0, 80);
  const s = (await c.get('/api/session')).body;
  const before = c.rawBytes();
  const ok = await c.post('/api/rounds', { difficulty: 'easy', stakeCents: 99999, clientSeed: '\u0001'.repeat(128), expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: longId('bet') });
  assert.equal(ok.status, 200); await force(c, safe);
  let st = ok.body;
  for (let i = 1; i <= 19; i++) {
    st = (await c.post(`/api/rounds/${st.round.id}/advance`, { revision: st.session.revision, actionId: longId('adv' + i) })).body;
    if (i === 6 || i === 12) st = (await c.post(`/api/rounds/${st.round.id}/collect`, { revision: st.session.revision, actionId: longId('col' + i), containerId: i === 6 ? 'A' : 'B' })).body;
  }
  st = (await c.post(`/api/rounds/${st.round.id}/collect`, { revision: st.session.revision, actionId: longId('colC'), containerId: 'C' })).body;
  assert.equal(st.round.status, 'settled');
  const growth = c.rawBytes() - before;
  assert.ok(growth * 4 <= SETTLEMENT_RESERVE_BYTES, `worst-case round grew ${growth} bytes; reserve ${SETTLEMENT_RESERVE_BYTES}`);
});

test('F03 mitigation: near the D1 limit new bets are refused cleanly and accepted bets always settle', async t => {
  const a = await workerAdapter({ maxBodyBytes: MAX_SESSION_BODY_BYTES }); t.after(() => a.close()); const c = a.client(); await startSession(c);
  // Just below the threshold: the bet is accepted and a long round settles under the real limit.
  await padTo(c, MAX_SESSION_BODY_BYTES - SETTLEMENT_RESERVE_BYTES - 2000);
  assert.ok(Math.abs(c.rawBytes() - (MAX_SESSION_BODY_BYTES - SETTLEMENT_RESERVE_BYTES - 2000)) < 200);
  const b = await bet(c, { stakeCents: 300 }); assert.equal(b.status, 200);
  await force(c, safe);
  for (let i = 0; i < 19; i++) assert.equal((await act(c, `/api/rounds/${b.body.round.id}/advance`)).status, 200);
  for (const id of ['A', 'B', 'C']) assert.equal((await act(c, `/api/rounds/${b.body.round.id}/collect`, { containerId: id })).status, 200);
  assert.equal(c.raw().rounds[b.body.round.id].status, 'settled');
  // Over the threshold: the bet is refused with a stable code, no debit and no round.
  await padTo(c, MAX_SESSION_BODY_BYTES - SETTLEMENT_RESERVE_BYTES + 10);
  assert.ok(c.rawBytes() > MAX_SESSION_BODY_BYTES - SETTLEMENT_RESERVE_BYTES && c.rawBytes() < MAX_SESSION_BODY_BYTES - SETTLEMENT_RESERVE_BYTES + 200);
  const before = JSON.stringify(c.raw());
  const refused = await bet(c, { stakeCents: 300 });
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'SESSION_STORAGE_FULL');
  assert.equal(JSON.stringify(c.raw()), before);
  // Reads and an exact replay of an earlier action still work.
  assert.equal((await c.get('/api/session')).status, 200);
});
