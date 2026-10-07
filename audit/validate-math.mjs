// Exact mathematical validation of the Cargo payout model.
//
// Usage: node audit/validate-math.mjs [--out audit/results/math.json]
//
// Every check compares PRODUCTION functions/tables (public/math.js) with an
// independent BigInt/rational reference (audit/lib/exact.mjs). Floating point
// is used only for printing. Exits non-zero if any check fails.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODES, RULES, CONTAINERS, splitStake, payout, multiplier, nextRisk } from '../public/math.js';
import { Fraction, choose, survival, survivalCount, conditionalLoss, nominalMultiplier100, referenceSplit,
  referencePayout, forEachSubset, DOCUMENTED, pct } from './lib/exact.mjs';

const arg = (n, f) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : f; };
const outFile = arg('out', fileURLToPath(new URL('./results/math.json', import.meta.url)));
const checks = [], t0 = Date.now();
function check(id, title, assumption, method, fn) {
  const started = Date.now();
  let result;
  try { result = fn(); } catch (error) { result = { pass: false, error: error.stack }; }
  checks.push({ id, title, assumption, method, ...result, ms: Date.now() - started });
  console.error(`${result.pass ? 'PASS' : 'FAIL'} ${id} ${title} (${Date.now() - started} ms)`);
}
const modeKeys = Object.keys(MODES);
const N = m => MODES[m].payouts.length, H = m => MODES[m].hazards;
const MIN_STAKE = RULES.minBetCents / 3, MAX_STAKE = RULES.maxBetCents / 3;

check('M01', 'Configuration matches documented rules', 'README.md and docs/FAIRNESS.md describe the intended rules.',
  'Compare MODES hazard counts, stop counts (20−h), total stops (61), wager limits, starting balance and container IDs with documentation.', () => {
    const rows = modeKeys.map(m => ({ mode: m, hazards: H(m), stops: N(m), documented: DOCUMENTED[m], ok: H(m) === DOCUMENTED[m].hazards && N(m) === DOCUMENTED[m].stops && N(m) === 20 - H(m) }));
    const total = modeKeys.reduce((a, m) => a + N(m), 0);
    const rules = RULES.minBetCents === 300 && RULES.maxBetCents === 300000 && RULES.startingBalanceCents === 100000 && RULES.currency === 'USD' && CONTAINERS.join('') === 'ABC';
    return { pass: rows.every(r => r.ok) && total === 61 && rules && Object.isFrozen(MODES), rows, totalStops: total, rules: RULES,
      observation: { modesFrozen: Object.isFrozen(MODES), innerModeObjectsFrozen: modeKeys.every(m => Object.isFrozen(MODES[m])), payoutArraysFrozen: modeKeys.every(m => Object.isFrozen(MODES[m].payouts)) } };
  });

check('M02', 'Exhaustive hazard-subset enumeration reproduces survival counts', 'A hazard deck is a uniformly random h-subset of {1..20} (follows from an unbiased Fisher–Yates shuffle).',
  'Enumerate every h-subset (20 + 1,140 + 15,504 + 184,756 = 201,420). For each stop s count subsets whose minimum exceeds s; compare with C(20−s,h).', () => {
    let subsets = 0; const rows = [];
    for (const m of modeKeys) {
      const counts = Array(21).fill(0); let n = 0;
      forEachSubset(H(m), sub => { n++; counts[sub[0]]++; });
      subsets += n;
      let tail = 0; const surv = Array(21).fill(0);
      for (let s = 20; s >= 0; s--) { surv[s] = tail; tail += counts[s]; }
      const mismatches = [];
      for (let s = 1; s <= N(m); s++) if (BigInt(surv[s]) !== survivalCount(H(m), s)) mismatches.push(s);
      rows.push({ mode: m, subsets: n, expected: choose(20, H(m)).toString(), mismatches });
    }
    return { pass: subsets === 201420 && rows.every(r => r.mismatches.length === 0 && String(r.subsets) === r.expected), totalSubsets: subsets, rows };
  });

check('M03', 'Conditional loss, cumulative survival and nextRisk() are mutually consistent', 'Documented formulas: p_s = h/(21−s), S_s = C(20−s,h)/C(20,h).',
  'Exactly verify S_s = Π(1−p_j) for every stop; compare production nextRisk(mode, s−1) with h/(21−s); check nextRisk at the final stop is 0.', () => {
    const issues = [];
    for (const m of modeKeys) {
      let prod = new Fraction(1);
      for (let s = 1; s <= N(m); s++) {
        prod = prod.mul(new Fraction(1).sub(conditionalLoss(H(m), s)));
        if (!prod.eq(survival(H(m), s))) issues.push({ m, s, issue: 'product≠survival' });
        const nr = nextRisk(m, s - 1), exact = conditionalLoss(H(m), s);
        if (Math.abs(nr - exact.toNumber()) > 1e-15) issues.push({ m, s, issue: 'nextRisk', nr, exact: exact.toFixed(15) });
      }
      if (nextRisk(m, N(m)) !== 0) issues.push({ m, issue: 'final nextRisk not 0' });
    }
    return { pass: issues.length === 0, issues };
  });

check('M04', 'All 61 multipliers equal round-half-up(98 / S_s) in hundredths; exact ties identified', 'docs/FAIRNESS.md: "round(0.98 / survival, 2)"; public/math.js integer hundredths are authoritative.',
  'Compute 98·C(20,h)/C(20−s,h) exactly as a rational; round half up; compare with MODES payouts. Detect exact .5 ties (where rounding direction would be ambiguous) and measure the distance to the nearest tie. Also confirm the existing float-based test cannot disagree.', () => {
    const rows = [], mismatches = [];
    let ties = 0, minTieDistance = null; const tieRows = [];
    for (const m of modeKeys) for (let s = 1; s <= N(m); s++) {
      const r = nominalMultiplier100(H(m), s), table = MODES[m].payouts[s - 1];
      const frac = r.exact.sub(new Fraction(r.exact.n / r.exact.d)); // fractional part
      const distance = frac.sub(new Fraction(1, 2)); const absD = distance.n < 0n ? distance.mul(-1) : distance;
      if (minTieDistance === null || absD.cmp(minTieDistance) < 0) minTieDistance = absD;
      if (r.isTie) { ties++; tieRows.push({ mode: m, stop: s, exactHundredths: r.exact.toFixed(6), table, halfUp: r.value.toString(), halfEven: (r.value % 2n === 0n ? r.value : r.value - 1n).toString(), conventionMatters: r.value % 2n !== 0n }); }
      const floatVersion = Math.round(98 / (Number(survivalCount(H(m), s)) / Number(choose(20, H(m)))));
      if (BigInt(table) !== r.value || floatVersion !== table) mismatches.push({ m, s, table, exact: r.value.toString(), floatVersion });
      if (s > 1 && MODES[m].payouts[s - 1] <= MODES[m].payouts[s - 2]) mismatches.push({ m, s, issue: 'not increasing' });
      rows.push({ mode: m, stop: s, multiplier100: table, unrounded100: r.exact.toFixed(6) });
    }
    // Exact ties are reported as an observation: the table follows half-up consistently,
    // but the documented formula "round(0.98/survival, 2)" does not name a tie rule.
    return { pass: mismatches.length === 0, count: rows.length, ties, tieRows, minDistanceToHalfTie: minTieDistance.toFixed(6), mismatches, rows };
  });

check('M05', 'Stake split conserves every permitted total wager', 'Remainder cents go to A then B (README.md).',
  'For every W in 300..300,000 (299,701 values) compare production splitStake(W) with an independent BigInt split; check the sum equals W and max−min ≤ 1 cent.', () => {
    let n = 0; const bad = [];
    for (let W = RULES.minBetCents; W <= RULES.maxBetCents; W++) {
      n++; const p = splitStake(W), r = referenceSplit(W);
      if (p.length !== 3 || p.some((v, i) => BigInt(v) !== r[i]) || p[0] + p[1] + p[2] !== W || Math.max(...p) - Math.min(...p) > 1) { bad.push(W); if (bad.length > 20) break; }
    }
    return { pass: n === 299701 && bad.length === 0, wagersChecked: n, failures: bad };
  });

check('M06', 'Payout rounding matches BigInt half-up for every reachable stake × multiplier pair', 'Payout = floor((w·M + 50)/100) cents (docs/FAIRNESS.md).',
  'For every individual stake w in 100..100,000 cents and all 61 multipliers (99,901 × 61 = 6,093,961 pairs) compare production payout() with BigInt arithmetic. Also confirm the largest intermediate product is a safe integer.', () => {
    let pairs = 0; const bad = []; let maxProduct = 0;
    const all = modeKeys.flatMap(m => MODES[m].payouts);
    for (let w = MIN_STAKE; w <= MAX_STAKE; w++) for (const M of all) {
      pairs++; const p = payout(w, M);
      if (BigInt(p) !== referencePayout(w, M)) { bad.push({ w, M, p }); if (bad.length > 20) break; }
      if (w * M > maxProduct) maxProduct = w * M;
    }
    return { pass: pairs === 6093961 && bad.length === 0 && Number.isSafeInteger(maxProduct + 50), pairs, failures: bad, maxProduct, maxSafeInteger: Number.MAX_SAFE_INTEGER, headroomFactor: Math.floor(Number.MAX_SAFE_INTEGER / maxProduct) };
  });

// Per-stop table including exact cent-RTP extremes across all permitted wagers.
const perStop = {};
check('M07', 'Per-stop odds, nominal RTP and exhaustive cent-RTP range', 'All surviving containers are collected at the same stop; RTP = S_s·Σg(w_i,s)/W.',
  'For each of the 61 stops: exact conditional/cumulative survival, nominal RTP S·M/100, and the exact min/max of S·Σg/W over all 299,701 wagers (BigInt cross-multiplication when products exceed 2^52).', () => {
    for (const m of modeKeys) {
      perStop[m] = [];
      for (let s = 1; s <= N(m); s++) {
        const M = MODES[m].payouts[s - 1], S = survival(H(m), s);
        let lo = null, hi = null;
        for (let W = RULES.minBetCents; W <= RULES.maxBetCents; W++) {
          const [a, b, c] = splitStake(W), g = payout(a, M) + payout(b, M) + payout(c, M);
          if (lo === null) { lo = { g, W }; hi = { g, W }; continue; }
          const less = (x, y) => { const l = x.g * y.W, r = y.g * x.W; return (l > 2 ** 52 || r > 2 ** 52) ? BigInt(x.g) * BigInt(y.W) < BigInt(y.g) * BigInt(x.W) : l < r; };
          const cur = { g, W };
          if (less(cur, lo)) lo = cur;
          if (less(hi, cur)) hi = cur;
        }
        const rtp = S.mul(new Fraction(M, 100));
        perStop[m].push({ stop: s, multiplier100: M, conditionalSurvival: new Fraction(1).sub(conditionalLoss(H(m), s)), conditionalLoss: conditionalLoss(H(m), s),
          survival: S, nominalRTP: rtp, centRTPMin: S.mul(new Fraction(lo.g, lo.W)), centRTPMinAtW: lo.W, centRTPMax: S.mul(new Fraction(hi.g, hi.W)), centRTPMaxAtW: hi.W,
          maxGrossAtMaxBetCents: 3 * payout(MAX_STAKE, M) });
      }
    }
    const below = [], above = [];
    for (const m of modeKeys) for (const r of perStop[m]) { if (r.nominalRTP.cmp(new Fraction(98, 100)) < 0) below.push(`${m}:${r.stop}`); if (r.nominalRTP.cmp(new Fraction(98, 100)) > 0) above.push(`${m}:${r.stop}`); }
    return { pass: true, stopsBelowNominal98: below, stopsAboveNominal98: above,
      table: Object.fromEntries(modeKeys.map(m => [m, perStop[m].map(r => ({ stop: r.stop, multiplier100: r.multiplier100, condSurvival: pct(r.conditionalSurvival), condLoss: pct(r.conditionalLoss), cumSurvival: pct(r.survival), cumLoss: pct(new Fraction(1).sub(r.survival)), nominalRTP: pct(r.nominalRTP), centRTPMin: pct(r.centRTPMin), centRTPMinAtW: r.centRTPMinAtW, centRTPMax: pct(r.centRTPMax), centRTPMaxAtW: r.centRTPMaxAtW, maxGrossAtMaxBetCents: r.maxGrossAtMaxBetCents }))])) };
  });

// Best single-container value per stake: maximise C(20−t,h)·g(w,t).
const bestByStake = {};
function bestFor(m, w) {
  let best = -1n, at = 0;
  for (let t = 1; t <= N(m); t++) { const v = survivalCount(H(m), t) * BigInt(payout(w, MODES[m].payouts[t - 1])); if (v > best) { best = v; at = t; } }
  return { v: best, t: at };
}
check('M08', 'Exhaustive optimal-stopping RTP over every permitted wager', 'Containers are independent (separate HMAC domains) and the player cannot see future hazards; then the optimum is the sum of single-container optima (proved in audit §6 and checked by M09).',
  'For each stake w (99,901 values) find t maximising S_t·g(w,t); for every total W (299,701) sum the three container optima; report the exact maximum RTP and its wager.', () => {
    const rows = [];
    for (const m of modeKeys) {
      const D = choose(20, H(m)); bestByStake[m] = new Array(MAX_STAKE + 1);
      for (let w = MIN_STAKE; w <= MAX_STAKE; w++) bestByStake[m][w] = bestFor(m, w);
      let top = null, bottom = null;
      for (let W = RULES.minBetCents; W <= RULES.maxBetCents; W++) {
        const parts = splitStake(W), v = parts.reduce((a, w) => a + bestByStake[m][w].v, 0n);
        const cand = { v, W, parts };
        if (!top || v * BigInt(top.W) > top.v * BigInt(W)) top = cand;
        if (!bottom || v * BigInt(bottom.W) < bottom.v * BigInt(W)) bottom = cand;
      }
      const rtp = new Fraction(top.v, D * BigInt(top.W)), low = new Fraction(bottom.v, D * BigInt(bottom.W));
      rows.push({ mode: m, bestTotalWagerCents: top.W, stakes: top.parts, targets: top.parts.map(w => bestByStake[m][w].t), maxRTP: pct(rtp), maxRTPExact: `${rtp.n}/${rtp.d}`, minHouseEdge: pct(new Fraction(1).sub(rtp)),
        lowestOptimalRTP: pct(low), lowestOptimalAtW: bottom.W, maxRTPFraction: rtp });
    }
    const global = rows.reduce((a, r) => (r.maxRTPFraction.cmp(a.maxRTPFraction) > 0 ? r : a));
    const pass = rows.every(r => r.maxRTPFraction.cmp(new Fraction(1)) < 0);
    rows.forEach(r => delete r.maxRTPFraction);
    return { pass, rows, global: { mode: global.mode, wager: global.bestTotalWagerCents, maxRTP: global.maxRTP, exact: global.maxRTPExact } };
  });

// Full joint Bellman program over (stop, onboard set) — does not assume factorisation.
function jointBellman(m, W) {
  const n = N(m), h = H(m), stakes = splitStake(W);
  const g = (i, s) => new Fraction(payout(stakes[i], MODES[m].payouts[s - 1]));
  const memo = new Map();
  const subsets = mask => { const out = []; for (let sub = mask; ; sub = (sub - 1) & mask) { out.push(sub); if (sub === 0) break; } return out; };
  const bits = mask => [0, 1, 2].filter(i => mask & (1 << i));
  function cont(s, mask) { // expected value of advancing from stop s with `mask` onboard
    if (mask === 0) return new Fraction(0);
    const q = new Fraction(1).sub(conditionalLoss(h, s + 1)), p = new Fraction(1).sub(q), b = bits(mask);
    let ev = new Fraction(0);
    for (const surv of subsets(mask)) {
      let pr = new Fraction(1);
      for (const i of b) pr = pr.mul(surv & (1 << i) ? q : p);
      ev = ev.add(pr.mul(V(s + 1, surv)));
    }
    return ev;
  }
  function V(s, mask) {
    const key = s * 8 + mask; if (memo.has(key)) return memo.get(key);
    let best;
    if (mask === 0) best = new Fraction(0);
    else if (s === 0) best = cont(0, mask);
    else if (s === n) best = bits(mask).reduce((a, i) => a.add(g(i, s)), new Fraction(0));
    else for (const take of subsets(mask)) {
      const v = bits(take).reduce((a, i) => a.add(g(i, s)), new Fraction(0)).add(cont(s, mask & ~take));
      if (!best || v.cmp(best) > 0) best = v;
    }
    memo.set(key, best); return best;
  }
  const joint = V(0, 7).div(W);
  const factor = stakes.reduce((a, w) => a.add(new Fraction(bestFor(m, w).v, choose(20, h))), new Fraction(0)).div(W);
  return { joint, factor };
}
check('M09', 'Joint three-container Bellman optimum equals the factorised optimum', 'Container survivals are mutually independent given the documented RNG; within a container hazards are drawn without replacement.',
  'Solve the exact joint dynamic program over every (stop, onboard-set) state and every collectable subset with rational arithmetic, for 4 modes × 12 wagers including uneven splits. Require exact equality with the sum of single-container optima.', () => {
    const wagers = [300, 301, 302, 315, 333, 336, 3000, 3001, 3002, 30000, 299999, 300000], rows = [];
    for (const m of modeKeys) for (const W of wagers) { const { joint, factor } = jointBellman(m, W); rows.push({ mode: m, W, jointRTP: pct(joint, 9), factorisedRTP: pct(factor, 9), exactEqual: joint.eq(factor) }); }
    return { pass: rows.every(r => r.exactEqual), cases: rows.length, rows };
  });

check('M10', 'Strategy comparison at a $30 wager ($10 per container)', 'Same as M09. Mid = ceil(N/2). Adaptive rule exactly as described in audit §6.',
  'Closed-form expectation with exact rationals for each named strategy; independent of simulation.', () => {
    const W = 3000, w = 1000, rows = [];
    const E = (m, t) => survival(H(m), t).mul(payout(w, MODES[m].payouts[t - 1])); // expected credit of one container targeting t
    for (const m of modeKeys) {
      const n = N(m), mid = Math.ceil(n / 2), S1 = survival(H(m), 1);
      const allFirst = E(m, 1).mul(3).div(W), allFinal = E(m, n).mul(3).div(W);
      const split = E(m, 1).add(E(m, mid)).add(E(m, n)).div(W), aFirst = E(m, 1).add(E(m, n).mul(2)).div(W);
      // Adaptive: A at 1; B at Mid if all three survived stop 1, else B at 1 if alive; C at final.
      const all3 = S1.mul(S1).mul(S1), g1 = new Fraction(payout(w, MODES[m].payouts[0]));
      const bTerm = all3.mul(survival(H(m), mid).div(S1)).mul(payout(w, MODES[m].payouts[mid - 1])).add(S1.sub(all3).mul(g1));
      const adaptive = E(m, 1).add(bTerm).add(E(m, n)).div(W);
      const optimal = new Fraction(bestFor(m, w).v * 3n, choose(20, H(m)) * BigInt(W));
      rows.push({ mode: m, mid, allAtFirst: pct(allFirst), allAtFinal: pct(allFinal), abcAt1MidFinal: pct(split), aAt1BCFinal: pct(aFirst), adaptive: pct(adaptive), optimalAt30: pct(optimal) });
    }
    return { pass: true, rows };
  });

check('M11', 'Maximum exposure and final-stop probabilities', 'No maximum-win cap exists in the source (confirmed by reading server/game.js and public/math.js).',
  'Exact payout at the largest container stake and the final multiplier; P(≥1 reaches final) = 1−(1−S_N)^3, P(all three) = S_N^3.', () => {
    const rows = modeKeys.map(m => {
      const S = survival(H(m), N(m)), one = payout(MAX_STAKE, MODES[m].payouts.at(-1)), none = new Fraction(1).sub(S);
      return { mode: m, maxOneCargoCents: one, maxRoundGrossCents: 3 * one, maxRoundNetCents: 3 * one - RULES.maxBetCents,
        pAtLeastOneReachesFinal: pct(new Fraction(1).sub(none.mul(none).mul(none)), 9), pAllThreeReachFinal: S.mul(S).mul(S).toNumber().toExponential(9),
        finalSurvivalPerCargo: `1/${S.d / S.n}` };
    });
    return { pass: true, rows, globalMaxRoundGrossCents: Math.max(...rows.map(r => r.maxRoundGrossCents)) };
  });

check('M12', 'Theoretical variance of return/wager at the final stop (equal stakes, no rounding)', 'Survivor count K ~ Binomial(3, S_N); X = m·K/3.',
  'Var(X) = m²·S·(1−S)/3 computed exactly with the table multiplier.', () => {
    const rows = modeKeys.map(m => { const S = survival(H(m), N(m)), mm = new Fraction(MODES[m].payouts.at(-1), 100); return { mode: m, variance: mm.mul(mm).mul(S).mul(new Fraction(1).sub(S)).div(3).toFixed(6) }; });
    return { pass: true, rows };
  });

check('M13', 'Rounding effect bound', 'RTP deviation from 98% comes only from multiplier rounding (≤ 0.005·S in RTP) and payout rounding (≤ 0.5 cent per container).',
  'Exactly verify |S·M/100 − 0.98| ≤ 0.005·S for every stop (multiplier rounding), and that every exhaustive cent-RTP extreme lies within a further S·(1.5 cents / 300 cents) = S/200 of the nominal RTP (payout rounding, ≤0.5 cent per container on a ≥$3 wager).', () => {
    const issues = [];
    for (const m of modeKeys) for (const r of perStop[m]) {
      const dev = r.nominalRTP.sub(new Fraction(98, 100)), absDev = dev.n < 0n ? dev.mul(-1) : dev;
      if (absDev.cmp(r.survival.mul(new Fraction(5, 1000))) > 0) issues.push({ m, s: r.stop, issue: 'multiplier rounding bound' });
      const centBound = r.survival.mul(new Fraction(1, 2 * MIN_STAKE));
      for (const ext of [r.centRTPMin, r.centRTPMax]) { const d = ext.sub(r.nominalRTP), a = d.n < 0n ? d.mul(-1) : d; if (a.cmp(centBound) > 0) issues.push({ m, s: r.stop, issue: 'cent rounding bound' }); }
    }
    return { pass: issues.length === 0, issues };
  });

const failed = checks.filter(c => !c.pass);
const out = { meta: { script: 'audit/validate-math.mjs', node: process.version, generatedAt: new Date().toISOString(), runtimeMs: Date.now() - t0, productionFiles: ['public/math.js'] },
  summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.map(c => c.id) }, checks };
fs.mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Fraction ? v.toFixed(12) : v), 1));
console.error(`${checks.length - failed.length}/${checks.length} math checks passed → ${outFile}`);
process.exitCode = failed.length ? 1 : 0;
