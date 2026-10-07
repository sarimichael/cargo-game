// Deterministic state-machine fuzz of the authoritative engine (server/game.js).
// Run: node --test audit/tests/*.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES, CONTAINERS, payout, multiplier, splitStake } from '../../public/math.js';
import { createSession, beginRound, advanceRound, collectRound, resetWallet, publicRound, snapshot, GameError } from '../../server/game.js';
import { seedHash } from '../../server/fairness.js';
import { verifyRound } from '../../public/fairness.js';
import { collisionFor } from '../../public/collision.js';
import { derivedSeed, splitmix } from '../lib/seeds.mjs';

const ROUNDS = 1500;

function invariants(s, r, label) {
  const sum = s.ledger.reduce((a, e) => a + e.amountCents, 0);
  assert.equal(100000 + sum, s.balanceCents, label + ': ledger reconciles');
  assert.equal(new Set(s.ledger.map(e => e.id)).size, s.ledger.length, label + ': unique ledger ids');
  assert.ok(Number.isSafeInteger(s.balanceCents) && s.balanceCents >= 0, label + ': balance');
  assert.equal(r.containers.reduce((a, c) => a + c.stakeCents, 0), r.stakeCents, label + ': stakes conserve');
  for (const c of r.containers) {
    assert.ok(['onboard', 'collected', 'lost'].includes(c.status));
    if (c.status === 'onboard') assert.ok(c.payoutCents === 0 && c.collectedAt === null && c.lostAt === null);
    if (c.status === 'lost') assert.ok(c.payoutCents === 0 && c.collectedAt === null && c.lostAt >= 1 && r.hazards[c.id].includes(c.lostAt));
    if (c.status === 'collected') assert.ok(c.lostAt === null && c.collectedAt >= 1 && c.payoutCents === payout(c.stakeCents, multiplier(r.difficulty, c.collectedAt)));
    // A container is lost exactly at its first hazard if it was still onboard then.
    const first = Math.min(...r.hazards[c.id]);
    if (c.status === 'lost') assert.equal(c.lostAt, first);
    if (c.status === 'collected') assert.ok(c.collectedAt < first);
  }
  assert.equal(r.status === 'settled', r.containers.every(c => c.status !== 'onboard'), label + ': settled iff nothing onboard');
  assert.ok(r.step >= 0 && r.step <= MODES[r.difficulty].payouts.length);
  const p = publicRound(r);
  if (r.status === 'active') assert.ok(!('serverSeed' in p.proof) && !('hazards' in p.proof), label + ': no active leak');
  assert.ok(!JSON.stringify(snapshot(s)).includes(s.nextSeed), label + ': next seed hidden');
}

test(`fuzz ${ROUNDS} deterministic rounds: invariants hold after every valid and invalid action`, async () => {
  const rng = splitmix('statemachine-v1');
  let s, verified = 0, rejected = 0, collisions = { iceberg: 0, debris: 0 };
  for (let i = 0; i < ROUNDS; i++) {
    // A fresh session every 100 rounds keeps the per-action state comparison linear.
    if (i % 100 === 0) s = createSession('fuzz' + i, derivedSeed('fuzz-session', i));
    const mode = rng.pick(Object.keys(MODES)), stake = 300 + rng.int(20000);
    if (s.balanceCents < stake) resetWallet(s);
    const r = beginRound(s, { difficulty: mode, stakeCents: stake, clientSeed: 'fz' + i, expectedSeedHash: seedHash(s.nextSeed) }, derivedSeed('fuzz', i + 1));
    assert.deepEqual(r.containers.map(c => c.stakeCents), splitStake(stake));
    invariants(s, r, `round ${i} start`);
    while (r.status === 'active') {
      const before = JSON.stringify(s), prev = structuredClone(publicRound(r));
      const roll = rng.int(100), onboard = r.containers.filter(c => c.status === 'onboard').map(c => c.id);
      {
        if (roll < 8) {  // deliberately invalid actions must throw GameError and change nothing
          const bad = rng.pick([() => collectRound(s, r.id, rng.pick(r.containers.filter(c => c.status !== 'onboard').map(c => c.id).concat(['X', 'all ', '']))),
            () => advanceRound(s, 'not-a-round'), () => resetWallet(s),
            () => beginRound(s, { difficulty: mode, stakeCents: 300, clientSeed: 'x', expectedSeedHash: seedHash(s.nextSeed) }),
            () => (r.step === 0 ? collectRound(s, r.id, 'all') : r.step === MODES[mode].payouts.length ? advanceRound(s, r.id) : collectRound(s, r.id, 'Z'))]);
          assert.throws(bad, GameError); assert.equal(JSON.stringify(s), before, 'invalid action mutated state'); rejected++;
          continue;
        }
        if (r.step >= 1 && (roll < 25 || r.step === MODES[mode].payouts.length)) collectRound(s, r.id, rng.pick([...onboard, 'all']));
        else {
          advanceRound(s, r.id);
          const col = collisionFor(prev, publicRound(r)), newlyLost = r.containers.filter((c, k) => c.status === 'lost' && prev.containers[k].status === 'onboard').map(c => c.id);
          const all = r.containers.every(c => c.status === 'lost');
          assert.equal(col?.kind ?? null, newlyLost.length ? (all ? 'iceberg' : 'debris') : null);
          if (col) collisions[col.kind]++;
        }
      }
      invariants(s, r, `round ${i} step ${r.step}`);
    }
    if (i % 10 === 0) { assert.equal((await verifyRound(publicRound(r))).valid, true); verified++; }
  }
  assert.ok(rejected > 100 && collisions.iceberg > 0 && collisions.debris > 0);
  assert.ok(verified >= ROUNDS / 10);
});

test('secured cargo is never affected by later losses (exhaustive over Easy collection timing)', () => {
  for (let hazardA = 1; hazardA <= 20; hazardA++) for (let collectAt = 1; collectAt <= 19; collectAt++) {
    const seed = derivedSeed('secured', hazardA * 100 + collectAt), s = createSession('sec', seed);
    const r = beginRound(s, { difficulty: 'easy', stakeCents: 300, clientSeed: 'c', expectedSeedHash: seedHash(seed) }, derivedSeed('secured-n', 0));
    r.hazards = { A: [hazardA], B: [1], C: [1] };
    while (r.status === 'active' && r.step < collectAt) advanceRound(s, r.id);
    const alive = r.containers[0].status === 'onboard';
    if (alive) { collectRound(s, r.id, 'A'); }
    assert.equal(r.status, 'settled');
    assert.equal(r.containers[0].status, hazardA > collectAt ? 'collected' : 'lost');
    assert.equal(s.balanceCents, 100000 - 300 + (hazardA > collectAt ? payout(100, MODES.easy.payouts[collectAt - 1]) : 0));
  }
});
