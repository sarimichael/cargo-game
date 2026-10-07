// CHARACTERIZATION TESTS FOR KNOWN, UNFIXED DEFECTS.
//
// Each test asserts the CURRENT (defective) behaviour so that the suite stays
// green while documenting it precisely. When a defect is fixed, the matching test
// WILL FAIL: invert its assertions into a protective regression test and update
// CARGO_VALIDATION_REPORT.md. Finding IDs refer to CARGO_SAYCOVE_AUDIT.md (F01–F11)
// and CARGO_VALIDATION_REPORT.md (N01–N04).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ADAPTERS, localAdapter, aid, startSession, bet, act } from '../lib/harness.mjs';
import { Store } from '../../server/store.js';
import { MODES } from '../../public/math.js';
import { createSession, beginRound, advanceRound, collectRound, publicRound } from '../../server/game.js';
import { seedHash } from '../../server/fairness.js';
import { verifyRound } from '../../public/fairness.js';
import { derivedSeed } from '../lib/seeds.mjs';

const safe = { A: [20], B: [20], C: [20] };
const force = (c, h) => c.mutate(s => { s.rounds[s.currentRoundId].hazards = h; });

for (const [kind, make] of Object.entries(ADAPTERS)) {
  test(`KNOWN DEFECT F01 (${kind}): reset restores $1,000 after a loss without operator authorisation`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client();
    const b = await bet(c, { stakeCents: 301 }); await force(c, { A: [1], B: [1], C: [1] }); await act(c, `/api/rounds/${b.body.round.id}/advance`);
    assert.equal(c.raw().balanceCents, 99699);
    assert.equal((await act(c, '/api/reset')).status, 200);
    assert.equal(c.raw().balanceCents, 100000);
  });

  test(`KNOWN DEFECT F05 (${kind}): final-port survivors remain active and uncredited until an explicit collect`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client();
    const b = await bet(c, { difficulty: 'expert' }); await force(c, safe); const id = b.body.round.id;
    for (let i = 0; i < 10; i++) await act(c, `/api/rounds/${id}/advance`);
    assert.equal((await act(c, `/api/rounds/${id}/advance`)).status, 409);
    assert.equal(c.raw().rounds[id].status, 'active');
    assert.equal(c.raw().ledger.filter(e => e.kind === 'collect').length, 0);
  });

  test(`KNOWN DEFECT F09 (${kind}): every cookieless GET /api/session persists a new funded session`, async t => {
    const a = await make(); t.after(() => a.close());
    const before = a.sessionCount(); for (let i = 0; i < 5; i++) await a.client().get('/api/session');
    assert.equal(a.sessionCount() - before, 5);
  });

  test(`KNOWN DEFECT F10 (${kind}): actionId "constructor" and reordered JSON keys produce false 409 conflicts`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client(); const s = await startSession(c);
    assert.equal((await c.post('/api/reset', { revision: s.session.revision, actionId: 'constructor' })).status, 409);
    const b = await bet(c); await force(c, safe); const adv = await act(c, `/api/rounds/${b.body.round.id}/advance`);
    const id = aid('k'), rev = adv.body.session.revision;
    assert.equal((await c.post(`/api/rounds/${b.body.round.id}/collect`, { revision: rev, actionId: id, containerId: 'all' })).status, 200);
    assert.equal((await c.post(`/api/rounds/${b.body.round.id}/collect`, { containerId: 'all', actionId: id, revision: rev })).status, 409);
    assert.equal(c.raw().ledger.filter(e => e.kind === 'collect').length, 3); // no duplicate credit
  });
}

test('KNOWN DEFECT F03: session state grows without bound (≈2.2 KB per short round on the local store)', async t => {
  const a = await localAdapter(); t.after(() => a.close()); const c = a.client(); await startSession(c);
  const size = () => fs.statSync(path.join(a.directory, 'state.json')).size, sizes = [size()];
  for (let i = 0; i < 20; i++) { const b = await bet(c, { stakeCents: 300 }); await act(c, `/api/rounds/${b.body.round.id}/advance`); if (c.raw().rounds[b.body.round.id].status === 'active') await act(c, `/api/rounds/${b.body.round.id}/collect`, { containerId: 'all' }); sizes.push(size()); }
  assert.ok(sizes.every((v, i) => i === 0 || v > sizes[i - 1]));
  assert.equal(Object.keys(c.raw().rounds).length, 20); // nothing is pruned
  assert.ok((sizes.at(-1) - sizes[0]) / 20 > 1500);
});

test('KNOWN DEFECT F07: two Store instances on one directory lose an acknowledged debit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-f07-'));
  try {
    const s1 = new Store(dir); s1.transaction(st => { st.sessions.x = createSession('x', derivedSeed('f07', 0)); });
    const s2 = new Store(dir);
    s1.transaction(st => { st.sessions.x.balanceCents -= 100; });
    s2.transaction(st => { st.sessions.y = {}; });
    assert.equal(new Store(dir).get('x').balanceCents, 100000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('KNOWN DEFECT F08: verifyRound() accepts altered algorithm, multiplier, id, valueCents and duplicate containers', async () => {
  let s, r;
  for (let k = 0; ; k++) { const seed = derivedSeed('f08', k); s = createSession('f08', seed); r = beginRound(s, { difficulty: 'easy', stakeCents: 3000, clientSeed: 'p', expectedSeedHash: seedHash(seed) }, derivedSeed('f08n', k)); advanceRound(s, r.id); if (r.containers.every(c => c.status === 'onboard')) break; }
  collectRound(s, r.id, 'all');
  const base = publicRound(r); assert.equal((await verifyRound(base)).valid, true);
  for (const tamper of [p => { p.proof.algorithm = 'other'; }, p => { p.multiplier100 = 1; }, p => { p.id = 'forged'; }, p => { p.containers[0].valueCents = 1e9; }, p => { p.containers.push(structuredClone(p.containers[0])); }]) {
    const p = structuredClone(base); tamper(p); assert.equal((await verifyRound(p)).valid, true);
  }
});

test('KNOWN DEFECT F11: an in-process payout-table change alters settlement of an already-accepted round', () => {
  assert.equal(Object.isFrozen(MODES.easy.payouts), false);
  const seed = derivedSeed('f11', 0), s = createSession('f11', seed);
  const r = beginRound(s, { difficulty: 'easy', stakeCents: 300, clientSeed: 'v', expectedSeedHash: seedHash(seed) }, derivedSeed('f11', 1));
  r.hazards = safe; advanceRound(s, r.id);
  assert.equal(Object.keys(r).some(k => /version|table/i.test(k)), false); // no math version pinned to the round
  const original = MODES.easy.payouts[0];
  try { MODES.easy.payouts[0] = 104; collectRound(s, r.id, 'A'); } finally { MODES.easy.payouts[0] = original; }
  assert.equal(r.containers[0].payoutCents, 104); // accepted at 1.03×, paid at 1.04×
});

test('KNOWN DEFECT N01: local server corrupts a UTF-8 client seed split across TCP chunks', async t => {
  const a = await localAdapter(); t.after(() => a.close()); const c = a.client(); const s = await startSession(c);
  const bytes = Buffer.from(JSON.stringify({ difficulty: 'easy', stakeCents: 300, clientSeed: 'ship-🚢', expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('u') }));
  const cut = bytes.indexOf(Buffer.from('🚢')) + 2;
  const status = await new Promise((resolve, reject) => {
    const req = http.request(a.url + '/api/rounds', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c.jar.header(), Origin: a.url, 'Content-Length': bytes.length } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(bytes.subarray(0, cut)); setTimeout(() => req.end(bytes.subarray(cut)), 60);
  });
  assert.equal(status, 200);
  assert.notEqual(Object.values(c.raw().rounds)[0].clientSeed, 'ship-🚢'); // stored with U+FFFD replacement characters
});

test('KNOWN DEFECT N02: payout tables are mutable at runtime (MODES is only shallow-frozen)', () => {
  assert.equal(Object.isFrozen(MODES), true);
  assert.equal(Object.isFrozen(MODES.expert), false);
  assert.equal(Object.isFrozen(MODES.expert.payouts), false);
});
