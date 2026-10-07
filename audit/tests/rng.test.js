// Regression tests for randomness and proofs. Run: node --test audit/tests/*.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hazardDeck, seedHash } from '../../server/fairness.js';
import { randomMessage } from '../../public/math.js';
import { verifyRound } from '../../public/fairness.js';
import { createSession, beginRound, advanceRound, collectRound, publicRound } from '../../server/game.js';
import { referenceHazardDeck, uniformBelow, referenceShuffle, TWO_32 } from '../lib/reference-rng.mjs';
import { derivedSeed } from '../lib/seeds.mjs';

const { vectors } = JSON.parse(fs.readFileSync(new URL('../results/rng-vectors.json', import.meta.url), 'utf8'));

test('108 known-answer hazard decks are unchanged (pins RNG behaviour at the audited commit)', () => {
  assert.equal(vectors.length, 108);
  for (const v of vectors) assert.deepEqual(hazardDeck(v.serverSeed, v.clientSeed, v.nonce, v.containerId, v.hazards), v.deck, `${v.mode}/${v.seedLabel}/${v.containerId}/${v.nonce}`);
});

test('production decks equal the specification-only reference implementation', () => {
  for (let i = 0; i < 200; i++) for (const c of ['A', 'B', 'C']) {
    const seed = derivedSeed('test-ref', i), h = [1, 3, 5, 10][i % 4];
    assert.deepEqual(hazardDeck(seed, 'ref-' + i, i, c, h), referenceHazardDeck(seed, 'ref-' + i, i, c, h));
  }
});

test('rejection sampling: exact divisibility for bounds 2..20 and forced rejection consumes an extra draw', () => {
  for (let b = 2; b <= 20; b++) { const limit = Math.floor(TWO_32 / b) * b; assert.equal(limit % b, 0); assert.ok(TWO_32 - limit < b); }
  const words = [0xFFFFFFFF, 7]; assert.equal(uniformBelow(20, () => words.shift()), 7); assert.equal(words.length, 0);
  let calls = 0; const stats = {}; referenceShuffle(() => (calls++ === 0 ? 0xFFFFFFFF : 12345), stats);
  assert.equal(stats.rejections, 1); assert.equal(calls, 20);
});

test('HMAC message is the documented JSON array and escapes unpaired surrogates', () => {
  assert.equal(randomMessage('s', 7, 'C', 3), '["cargo-v1","s",7,"C",3]');
  assert.equal(randomMessage('\ud800', 0, 'A', 0), '["cargo-v1","\\ud800",0,"A",0]');
  assert.notEqual(randomMessage('x","A', 0, 'B', 0), randomMessage('x', 0, 'A","B', 0));
});

test('browser verifier accepts natural rounds with stress client seeds and rejects a wrong seed', async () => {
  for (const [i, cs] of ['🚢⚓️', 'a","b', '\ud800x', 'x'.repeat(128)].entries()) {
    const seed = derivedSeed('test-verify', i), s = createSession('t', seed);
    const r = beginRound(s, { difficulty: 'medium', stakeCents: 3001, clientSeed: cs, expectedSeedHash: seedHash(seed) }, derivedSeed('test-verify-next', i));
    while (r.status === 'active') { if (r.step === 17) collectRound(s, r.id, 'all'); else { advanceRound(s, r.id); if (r.status === 'active' && r.step === 2) collectRound(s, r.id, 'A'); } }
    const p = publicRound(r);
    assert.equal((await verifyRound(p)).valid, true, cs);
    const wrong = structuredClone(p); wrong.proof.serverSeed = derivedSeed('other', i);
    assert.equal((await verifyRound(wrong)).valid, false);
  }
});

test('observation: difficulty is not in the HMAC message, so decks nest across difficulties', () => {
  // Harmless today because one committed seed serves exactly one round with a locked difficulty.
  const seed = derivedSeed('nest', 0), d = [1, 3, 5, 10].map(h => hazardDeck(seed, 'n', 0, 'A', h));
  for (let k = 1; k < 4; k++) assert.ok(d[k - 1].every(p => d[k].includes(p)));
});
