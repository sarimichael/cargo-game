// Statistical analysis of audit/results/simulation-raw.json (from simulate.mjs).
//
// Usage: node audit/analyze-simulation.mjs [--in audit/results/simulation-raw.json] [--out audit/results/simulation.json]
//
// These are DIAGNOSTIC screens, not a certification battery. Every p-value is
// reported; with many simultaneous tests some small p-values are expected by
// chance, so a Bonferroni threshold is shown alongside.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODES } from '../public/math.js';
import { survival, choose } from './lib/exact.mjs';
import { chiSquareGOF, chiSquareIndependence, wilson } from './lib/stats.mjs';

const arg = (n, f) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : f; };
const inFile = arg('in', fileURLToPath(new URL('./results/simulation-raw.json', import.meta.url)));
const outFile = arg('out', fileURLToPath(new URL('./results/simulation.json', import.meta.url)));
const raw = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const pvalues = [], modes = {};
const record = (mode, test, r) => { pvalues.push({ mode, test, p: r.p }); return { stat: +r.stat.toFixed(4), df: r.df, p: r.p, minExpected: +r.minExpected.toFixed(2) }; };

for (const [mode, m] of Object.entries(raw.modes)) {
  const h = MODES[mode].hazards, N = MODES[mode].payouts.length, n = m.rounds, D = Number(choose(20, h));
  const stops = [];
  for (let s = 1; s <= N; s++) {
    const k = m.countsK[s], survivors = k[1] + 2 * k[2] + 3 * k[3], S = survival(h, s).toNumber(), mult = MODES[mode].payouts[s - 1] / 100;
    const survZ = (survivors - 3 * n * S) / Math.sqrt(3 * n * S * (1 - S));
    // $30 total wager, $10 per container: payout(1000, M) = 10·M cents exactly, so return/wager = mult·K/3.
    const rtp = survivors * mult / (3 * n), theoryRTP = S * mult, theoryVar = mult * mult * S * (1 - S) / 3;
    const [lo, hi] = wilson(survivors, 3 * n);
    stops.push({ stop: s, countsK: k, survivors, expectedSurvivors: +(3 * n * S).toFixed(3), survivalZ: +survZ.toFixed(3), sampleRTP: +(rtp * 100).toFixed(5), theoryRTP: +(theoryRTP * 100).toFixed(6),
      rtpZ: +((rtp - theoryRTP) / Math.sqrt(theoryVar / n)).toFixed(3), hitRate: +((1 - k[0] / n) * 100).toFixed(5), zeroReturn: +((k[0] / n) * 100).toFixed(5), wilsonRTP95: [+(lo * mult * 100).toFixed(3), +(hi * mult * 100).toFixed(3)] });
  }
  // Each position appears in a deck with probability h/20, so position counts per container are uniform over 20 cells.
  const positions = m.positions.map((row, c) => record(mode, `positions ${'ABC'[c]}`, chiSquareGOF(row.slice(1), Array(20).fill(1 / 20))));
  // Distribution of the first hazard: P(min = p) = C(20−p, h−1)/C(20,h).
  const firstProbs = Array.from({ length: 20 }, (_, i) => Number(choose(20 - (i + 1), h - 1)) / D);
  const bins = []; { let acc = []; for (let p = 0; p < 20; p++) { acc.push(p); const prob = acc.reduce((a, j) => a + firstProbs[j], 0); if (prob * n >= 50 || p === 19) { bins.push(acc); acc = []; } } const last = bins.at(-1); if (last.reduce((a, j) => a + firstProbs[j], 0) * n < 50 && bins.length > 1) bins[bins.length - 2].push(...bins.pop()); }
  const binned = row => bins.map(b => b.reduce((a, j) => a + row[j + 1], 0)), binnedP = bins.map(b => b.reduce((a, j) => a + firstProbs[j], 0));
  const firstHazard = m.firstHazard.map((row, c) => record(mode, `first hazard ${'ABC'[c]}`, chiSquareGOF(binned(row), binnedP)));
  // Cross-container independence of first hazards (binned so every expected cell ≥ ~5 where possible).
  const binsSq = bins.filter(b => b.reduce((a, j) => a + firstProbs[j], 0) ** 2 * n >= 5);
  const pairBins = binsSq.length >= 2 ? [...binsSq.slice(0, -1), bins.slice(bins.indexOf(binsSq.at(-1))).flat()] : bins;
  const pairs = Object.fromEntries(Object.entries(m.pairs).map(([k, t]) => {
    const table = pairBins.map(bi => pairBins.map(bj => bi.reduce((a, i) => a + bj.reduce((x, j) => x + t[i + 1][j + 1], 0), 0)));
    return [k, record(mode, `independence ${k}`, chiSquareIndependence(table))];
  }));
  // Whole-deck uniformity where the deck space is small enough to populate.
  let decks = null;
  if (h <= 3) { const keys = []; const counts = []; { const idx = Array.from({ length: h }, (_, i) => i + 1); for (;;) { const key = idx.join(','); keys.push(key); counts.push(m.decks[key] || 0); let i = h - 1; while (i >= 0 && idx[i] === 20 - (h - 1 - i)) i--; if (i < 0) break; idx[i]++; for (let j = i + 1; j < h; j++) idx[j] = idx[j - 1] + 1; } }
    decks = { cells: keys.length, unexpectedKeys: Object.keys(m.decks).filter(k => !keys.includes(k)).length, ...record(mode, 'whole-deck uniformity (A+B+C pooled)', chiSquareGOF(counts, Array(keys.length).fill(1 / keys.length))) }; }
  const L = m.lag, cov = L.sxy / L.n - (L.sx / L.n) * (L.sy / L.n), r = cov / Math.sqrt((L.sxx / L.n - (L.sx / L.n) ** 2) * (L.syy / L.n - (L.sy / L.n) ** 2));
  const lagZ = r * Math.sqrt(L.n); pvalues.push({ mode, test: 'lag-1 first hazard A', p: 2 * (1 - normalCdf(Math.abs(lagZ))) });
  const expRepeats = m.adjacentPairs / D, repZ = (m.adjacentRepeatsA - expRepeats) / Math.sqrt(expRepeats * (1 - 1 / D));
  pvalues.push({ mode, test: 'adjacent A-deck repeats', p: 2 * (1 - normalCdf(Math.abs(repZ))) });
  modes[mode] = { rounds: n, routes: 3 * n, invalidDecks: m.invalidDecks, referenceCrossCheck: { decksCompared: m.referenceChecked * 3, mismatches: m.referenceMismatches }, streamHash: m.streamHash,
    maxAbsSurvivalZ: Math.max(...stops.map(x => Math.abs(x.survivalZ))), maxAbsRtpZ: Math.max(...stops.map(x => Math.abs(x.rtpZ))),
    positions, firstHazard, firstHazardBins: bins.map(b => b.map(j => j + 1)), pairIndependence: pairs, wholeDeck: decks,
    lag1: { pairs: L.n, r: +r.toFixed(7), z: +lagZ.toFixed(3) }, adjacentRepeatsA: { observed: m.adjacentRepeatsA, expected: +expRepeats.toFixed(3), z: +repZ.toFixed(3) }, stops };
  for (const x of stops) pvalues.push({ mode, test: `survival stop ${x.stop}`, p: 2 * (1 - normalCdf(Math.abs(x.survivalZ))) });
}
function normalCdf(z) { // Abramowitz–Stegun 7.1.26 via erf; adequate for screening p-values
  const t = 1 / (1 + 0.3275911 * z / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return 0.5 * (1 + y);
}
const ps = pvalues.map(x => x.p), bonf = 0.05 / ps.length;
const summary = { tests: ps.length, minP: Math.min(...ps), minPTest: pvalues.find(x => x.p === Math.min(...ps)), belowP01: ps.filter(p => p < 0.01).length, belowP001: ps.filter(p => p < 0.001).length,
  expectedBelowP01ByChance: +(ps.length * 0.01).toFixed(2), bonferroniThreshold: bonf, bonferroniRejections: pvalues.filter(x => x.p < bonf),
  invalidDecks: Object.values(modes).reduce((a, m) => a + m.invalidDecks, 0), referenceMismatches: Object.values(modes).reduce((a, m) => a + m.referenceCrossCheck.mismatches, 0) };
fs.writeFileSync(outFile, JSON.stringify({ meta: { script: 'audit/analyze-simulation.mjs', input: raw.meta, generatedAt: new Date().toISOString(),
  caveats: ['Stops within a mode reuse the same sampled routes, so per-stop statistics are correlated, not independent tests.', 'Rare final-stop tails are under-powered; analytical results (validate-math.mjs) govern them.', 'Derived SHA-256 seeds stand in for newSeed(); OS entropy is not tested.'] },
  summary, modes }, null, 1));
console.error(`analysed ${ps.length} p-values; min p=${summary.minP.toExponential(3)} (${summary.minPTest.mode} ${summary.minPTest.test}); Bonferroni rejections: ${summary.bonferroniRejections.length}; invalid decks: ${summary.invalidDecks}; reference mismatches: ${summary.referenceMismatches} → ${outFile}`);
