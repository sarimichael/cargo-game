// Regression tests for the payout mathematics. Run: node --test audit/tests/*.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MODES, RULES, splitStake, payout, multiplier, nextRisk } from '../../public/math.js';
import { Fraction, survival, nominalMultiplier100, referencePayout, referenceSplit, choose } from '../lib/exact.mjs';

// Fingerprint of the audited payout configuration (commit 13a9805 / 25d5181).
// If this fails, the payout table or hazard counts changed: re-run the full audit
// (audit/run-all.mjs) and update the fingerprint deliberately. See audit finding F11.
const AUDITED_LADDER_SHA256 = '9719f45d0b89f79fbccd682919b5adc44e7e12321dbdbad25721f67c01d98c87';
const ladder = () => JSON.stringify(Object.entries(MODES).map(([k, m]) => [k, m.hazards, m.payouts]));

test('payout ladder and hazard counts match the audited configuration', () => {
  assert.equal(createHash('sha256').update(ladder()).digest('hex'), AUDITED_LADDER_SHA256);
  assert.deepEqual(Object.values(MODES).map(m => [m.hazards, m.payouts.length]), [[1, 19], [3, 17], [5, 15], [10, 10]]);
  assert.deepEqual([RULES.minBetCents, RULES.maxBetCents, RULES.startingBalanceCents], [300, 300000, 100000]);
});

test('every multiplier is round-half-up(98/S) computed exactly; only two exact ties exist', () => {
  const ties = [];
  for (const [k, m] of Object.entries(MODES)) m.payouts.forEach((M, i) => {
    const r = nominalMultiplier100(m.hazards, i + 1);
    assert.equal(BigInt(M), r.value, `${k} stop ${i + 1}`);
    if (r.isTie) ties.push(`${k}:${i + 1}`);
  });
  // Easy stop 4 (122.5 → 123) depends on the half-up convention; half-even would give 122.
  assert.deepEqual(ties, ['easy:4', 'medium:4']);
});

test('conditional risk shown to players equals h/(21−s) and compounds to cumulative survival', () => {
  for (const [k, m] of Object.entries(MODES)) {
    let s = new Fraction(1);
    for (let stop = 1; stop <= m.payouts.length; stop++) {
      assert.ok(Math.abs(nextRisk(k, stop - 1) - m.hazards / (21 - stop)) < 1e-15);
      s = s.mul(new Fraction(21 - stop - m.hazards, 21 - stop));
      assert.ok(s.eq(survival(m.hazards, stop)));
    }
    assert.equal(nextRisk(k, m.payouts.length), 0);
  }
});

test('stake split and payout rounding agree with BigInt references at boundaries', () => {
  for (const W of [300, 301, 302, 303, 333, 3001, 3002, 99999, 299998, 299999, 300000]) {
    const p = splitStake(W);
    assert.deepEqual(p.map(BigInt), referenceSplit(W));
    assert.equal(p[0] + p[1] + p[2], W);
  }
  for (const w of [100, 101, 111, 112, 99999, 100000]) for (const m of Object.values(MODES)) for (const M of m.payouts)
    assert.equal(BigInt(payout(w, M)), referencePayout(w, M));
  assert.equal(payout(101, 150), 152); // .5 cent rounds up
  assert.equal(payout(111, 123), 137); // the audit's optimum example
  assert.ok(Number.isSafeInteger(100000 * Math.max(...Object.values(MODES).flatMap(m => m.payouts)) + 50));
  assert.equal(multiplier('easy', 0), 100);
});

test('audited optimum: $3.33 Easy collecting all at stop 4 returns exactly 548/555', () => {
  const rtp = survival(1, 4).mul(splitStake(333).reduce((a, w) => a + payout(w, MODES.easy.payouts[3]), 0)).div(333);
  assert.ok(rtp.eq(new Fraction(548, 555)));
  assert.equal(rtp.mul(100).toFixed(6), '98.738739');
  assert.ok(rtp.cmp(new Fraction(1)) < 0);
});

test('maximum exposure is $543,182,640 at a $3,000 Expert bet with no cap', () => {
  assert.equal(splitStake(300000).reduce((a, w) => a + payout(w, MODES.expert.payouts.at(-1)), 0), 54318264000);
  assert.equal(Number(choose(20, 10)), 184756);
});
