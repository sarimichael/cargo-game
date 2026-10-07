// CHARACTERIZATION TESTS FOR KNOWN, UNFIXED DEFECTS.
//
// Each test asserts the CURRENT (defective) behaviour so that the suite stays
// green while documenting it precisely. When a defect is fixed, the matching test
// WILL FAIL: move it into a protective regression test (see remediation.test.js)
// and update the reports. Finding IDs refer to CARGO_SAYCOVE_AUDIT.md (F01–F11) and
// CARGO_VALIDATION_REPORT.md (N01–N04).
//
// Phase 2 (CARGO_PHASE2_REMEDIATION_REPORT.md) fixed F08, F10, N01 and N02; their
// characterisations were replaced by protective tests in remediation.test.js. F11 is
// still open and is now reproduced the way it occurs in practice: a later deployment.
// Phase 4A fixed F07; its test below now asserts the protective behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADAPTERS, localAdapter, startSession, bet, act } from '../lib/harness.mjs';
import { loadEngineVariant } from '../lib/engine-variant.mjs';
import { Store } from '../../server/store.js';
import { MODES } from '../../public/math.js';
import { createSession, beginRound, advanceRound } from '../../server/game.js';
import { seedHash } from '../../server/fairness.js';
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
}

test('KNOWN DEFECT F03: session state grows without bound (≈2.2 KB per short round on the local store)', async t => {
  const a = await localAdapter(); t.after(() => a.close()); const c = a.client(); await startSession(c);
  const size = () => fs.statSync(path.join(a.directory, 'state.json')).size, sizes = [size()];
  for (let i = 0; i < 20; i++) { const b = await bet(c, { stakeCents: 300 }); await act(c, `/api/rounds/${b.body.round.id}/advance`); if (c.raw().rounds[b.body.round.id].status === 'active') await act(c, `/api/rounds/${b.body.round.id}/collect`, { containerId: 'all' }); sizes.push(size()); }
  assert.ok(sizes.every((v, i) => i === 0 || v > sizes[i - 1]));
  assert.equal(Object.keys(c.raw().rounds).length, 20); // nothing is pruned
  assert.ok((sizes.at(-1) - sizes[0]) / 20 > 1500);
});

test('F07 fixed: a second Store on the same directory cannot overwrite an acknowledged debit', () => {
  // Was a KNOWN DEFECT (lost update); fixed in phase 4A by the folder lock in server/lock.js.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-f07-'));
  try {
    const s1 = new Store(dir); s1.transaction(st => { st.sessions.x = createSession('x', derivedSeed('f07', 0)); });
    const s2 = new Store(dir);
    s1.transaction(st => { st.sessions.x.balanceCents -= 100; });
    assert.throws(() => s2.transaction(st => { st.sessions.y = {}; }), e => e.code === 'DATA_DIRECTORY_LOCKED');
    assert.equal(new Store(dir).get('x').balanceCents, 99900);
    s1.release();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('KNOWN DEFECT F11: a deployment that changes the payout table alters settlement of an already-accepted round', async () => {
  // Accept and advance a round with the current engine, persist it as JSON (as both stores do),
  // then settle it with a freshly loaded engine whose Easy stop-1 multiplier is 1.04× instead of 1.03×.
  const seed = derivedSeed('f11', 0), s = createSession('f11', seed);
  const r = beginRound(s, { difficulty: 'easy', stakeCents: 300, clientSeed: 'v', expectedSeedHash: seedHash(seed) }, derivedSeed('f11', 1));
  r.hazards = safe; advanceRound(s, r.id);
  assert.equal(Object.keys(r).some(k => /version|table|payouts|multipliers/i.test(k)), false); // nothing pins the accepted rules
  const persisted = JSON.parse(JSON.stringify(s));
  const next = await loadEngineVariant(text => text.replace("1, [103,109,", "1, [104,109,"));
  assert.equal(next.math.MODES.easy.payouts[0], 104);
  next.game.collectRound(persisted, r.id, 'A');
  assert.equal(persisted.rounds[r.id].containers[0].payoutCents, 104); // accepted at 1.03×, paid at 1.04×
  assert.equal(MODES.easy.payouts[0], 103); // the running engine itself is unaffected (N02 fix)
});
