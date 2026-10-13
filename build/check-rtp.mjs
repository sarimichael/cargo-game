// Exhaustive, exact verification of the cargo-v2 return for every legal stake and mode.
// Integer/BigInt arithmetic only. It recomputes payouts and odds from the published formula and checks the
// engine's survivalOdds() against them; it does not rely on simulation.
import assert from 'node:assert/strict';
import { MODES, RULES, splitStake, survivalOdds } from '../public/math.js';

// The original two-decimal ladder, written out literally: cargo-v2 must not change any multiplier.
const ORIGINAL = {
  easy: [103,109,115,123,131,140,151,163,178,196,218,245,280,327,392,490,653,980,1960],
  medium: [115,137,164,200,246,307,391,508,677,931,1330,1995,3192,5586,11172,27930,111720],
  hard: [131,177,246,348,506,759,1181,1918,3289,6029,12059,27132,72352,253232,1519392],
  expert: [196,414,931,2261,6029,18088,63308,274335,1646008,18106088]
};
for (const mode of Object.keys(ORIGINAL)) assert.deepEqual([...MODES[mode].payouts], ORIGINAL[mode], mode + ' ladder changed');
assert.equal(RULES.algorithm, 'cargo-v2');

const G = (w, m) => (w * BigInt(m) + 50n) / 100n;            // nearest cent, half up
const TARGET_N = 968n, TARGET_D = 1000n;                       // 96.8%
const lt = (a, b) => a[0] * b[1] < b[0] * a[1];                  // fraction comparison, positive denominators
const eq = (a, b) => a[0] * b[1] === b[0] * a[1];
const mul = (a, b) => [a[0] * b[0], a[1] * b[1]];
const minStake = RULES.minBetCents / 3, maxStake = RULES.maxBetCents / 3;
const started = Date.now(), verified = {}, ranges = {};
let containerChecks = 0, stopChecks = 0;

for (const [mode, ladder] of Object.entries(ORIGINAL)) {
  const N = ladder.length, ok = new Uint8Array(maxStake + 1), range = ladder.map(() => [Infinity, -Infinity]);
  for (let stake = minStake; stake <= maxStake; stake++) {
    const w = BigInt(stake), g = ladder.map(m => G(w, m));
    // Independent odds: survive stop 1 with 121w/(125 G1); stop s with G(s-1)/G(s).
    const odds = g.map((gs, i) => i === 0 ? [121n * w, 125n * gs] : [g[i - 1], gs]);
    let survival = [1n, 1n];
    odds.forEach((p, i) => {
      const engine = survivalOdds('cargo-v2', mode, stake, i + 1);
      assert(engine[0] === Number(p[0]) && engine[1] === Number(p[1]), `${mode} w=${stake} stop ${i + 1}: engine odds differ`);
      assert(p[0] > 0n && p[0] < p[1], `${mode} w=${stake} stop ${i + 1}: not a probability strictly between 0 and 1`);
      survival = mul(survival, p);
      // Fixed-stop strategy "collect at stop s": P(reach s) × G_s = 0.968 w, exactly.
      assert(survival[0] * g[i] * TARGET_D === survival[1] * TARGET_N * w, `${mode} w=${stake} stop ${i + 1}: fixed-stop return differs`);
      const loss = Number(p[1] - p[0]) / Number(p[1]);
      range[i][0] = Math.min(range[i][0], loss); range[i][1] = Math.max(range[i][1], loss);
      stopChecks++;
    });
    // Best and worst value over every stopping rule for this container, by exact backward induction.
    // V_N = G_N; V_s = max/min(G_s, p_{s+1} V_{s+1}); the bet is worth p_1 V_1 before sailing.
    let best = [g[N - 1], 1n], worst = [g[N - 1], 1n];
    for (let s = N - 1; s >= 1; s--) {
      const stop = [g[s - 1], 1n], goOnBest = mul(odds[s], best), goOnWorst = mul(odds[s], worst);
      best = lt(stop, goOnBest) ? goOnBest : stop;
      worst = lt(goOnWorst, stop) ? goOnWorst : stop;
    }
    const target = [TARGET_N * w, TARGET_D];
    assert(eq(mul(odds[0], best), target) && eq(mul(odds[0], worst), target), `${mode} w=${stake}: some stopping rule differs from 96.8%`);
    ok[stake] = 1; containerChecks++;
  }
  verified[mode] = ok; ranges[mode] = range;
}

// Every legal total wager: the three container stakes are all verified, and their 96.8% values sum to 96.8% of the wager.
let wagerChecks = 0;
for (const mode of Object.keys(ORIGINAL)) for (let W = RULES.minBetCents; W <= RULES.maxBetCents; W++) {
  const parts = splitStake(W);
  assert.equal(parts.reduce((a, b) => a + b, 0), W);
  assert(parts.every(w => verified[mode][w]), `${mode} W=${W}: unverified container stake`);
  assert.equal(parts.reduce((a, w) => a + TARGET_N * BigInt(w), 0n) * 1n, TARGET_N * BigInt(W));
  wagerChecks++;
}

console.log(`cargo-v2 RTP check passed in ${((Date.now() - started) / 1000).toFixed(1)}s:`);
console.log(`  ${containerChecks.toLocaleString()} container stakes (${minStake}–${maxStake} cents × 4 modes), ${stopChecks.toLocaleString()} stop checks`);
console.log(`  ${wagerChecks.toLocaleString()} total wagers (${RULES.minBetCents}–${RULES.maxBetCents} cents × 4 modes)`);
console.log('  Every fixed stop, the best and the worst stopping rule each return exactly 96.8% of the stake.');
if (process.argv.includes('--table')) for (const [mode, range] of Object.entries(ranges)) {
  console.log(`\n${MODES[mode].name}: loss chance at each stop (cargo-v1 fixed deck → cargo-v2 range over all container stakes)`);
  range.forEach(([lo, hi], i) => console.log(`  stop ${String(i + 1).padStart(2)}: ${(MODES[mode].hazards / (20 - i) * 100).toFixed(3).padStart(7)}% → ${(lo * 100).toFixed(3)}%–${(hi * 100).toFixed(3)}%`));
}
