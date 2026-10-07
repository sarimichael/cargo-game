// Deterministic structural review of the Cargo RNG (server/fairness.js) and the
// browser verifier (public/fairness.js). Statistical screens live in
// analyze-simulation.mjs; this file proves equivalences and boundary behaviour.
//
// Usage: node audit/validate-rng.mjs [--out audit/results/rng.json]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hazardDeck, newSeed, seedHash } from '../server/fairness.js';
import { MODES, randomMessage, CONTAINERS } from '../public/math.js';
import { verifyRound } from '../public/fairness.js';
import { createSession, beginRound, advanceRound, collectRound, publicRound } from '../server/game.js';
import { referenceHazardDeck, referenceSeedHash, message, uniformBelow, referenceShuffle, TWO_32 } from './lib/reference-rng.mjs';
import { derivedSeed } from './lib/seeds.mjs';
import { createHash } from 'node:crypto';

const arg = (n, f) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : f; };
const outFile = arg('out', fileURLToPath(new URL('./results/rng.json', import.meta.url)));
const checks = [], t0 = Date.now();
async function check(id, title, assumption, method, fn) {
  const started = Date.now(); let result;
  try { result = await fn(); } catch (error) { result = { pass: false, error: error.stack }; }
  checks.push({ id, title, assumption, method, ...result, ms: Date.now() - started });
  console.error(`${result.pass ? 'PASS' : 'FAIL'} ${id} ${title} (${Date.now() - started} ms)`);
}
const modeKeys = Object.keys(MODES);
// Client seeds chosen to stress serialization: ASCII, max length, JSON metacharacters,
// astral-plane emoji, combining marks, RTL text and an unpaired surrogate.
const CLIENT_SEEDS = ['cargo-test', 'x'.repeat(128), 'a","b\\"c', '🚢⚓️ cargo', 'é́', 'שלום-סחורה', '\ud800lone', ' '];

await check('R01', 'Production hazardDeck() equals an independent re-implementation', 'docs/FAIRNESS.md fully specifies the algorithm.',
  '4 modes × 3 containers × 8 client seeds × 150 nonces = 14,400 decks. Each deck compared element-wise with audit/lib/reference-rng.mjs, written from the specification only.', () => {
    let compared = 0; const mismatches = [];
    for (const m of modeKeys) for (const cs of CLIENT_SEEDS) for (let nonce = 0; nonce < 150; nonce++) {
      const seed = derivedSeed('r01|' + m, nonce);
      for (const c of CONTAINERS) {
        compared++;
        const a = hazardDeck(seed, cs, nonce, c, MODES[m].hazards), b = referenceHazardDeck(seed, cs, nonce, c, MODES[m].hazards);
        if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push({ m, cs, nonce, c, a, b });
      }
    }
    return { pass: compared === 14400 && mismatches.length === 0, compared, mismatches: mismatches.slice(0, 10) };
  });

await check('R02', 'Browser Web Crypto verifier accepts engine rounds for every stress client seed and mode', 'public/fairness.js is the independent player-side check.',
  'For each mode × stress client seed × 6 nonces, play a deterministic round in the real engine (collect A at stop 1, B at stop 2, then sail until settled or collect at the final port), then run verifyRound() on publicRound().', async () => {
    let verified = 0; const failures = [];
    for (const m of modeKeys) for (const cs of CLIENT_SEEDS) for (let k = 0; k < 6; k++) {
      const seed = derivedSeed('r02|' + m + '|' + cs, k), s = createSession('r02', seed);
      const r = beginRound(s, { difficulty: m, stakeCents: 300 + k, clientSeed: cs, expectedSeedHash: seedHash(seed) }, derivedSeed('r02-next', k));
      while (r.status === 'active') {
        if (r.step === MODES[m].payouts.length) { collectRound(s, r.id, 'all'); break; }
        advanceRound(s, r.id);
        if (r.status !== 'active') break;
        const target = r.step === 1 ? 'A' : r.step === 2 ? 'B' : null;
        if (target && r.containers.find(c => c.id === target).status === 'onboard') collectRound(s, r.id, target);
      }
      const v = await verifyRound(publicRound(r)); verified++;
      if (!v.valid) failures.push({ m, cs, k, message: v.message });
    }
    return { pass: verified === 192 && failures.length === 0, verified, failures };
  });

await check('R03', 'Rejection sampling is exactly unbiased for every bound used (2..20)', 'Draw words are uniform 32-bit integers.',
  'For each bound b: limit = floor(2^32/b)·b; verify limit ≡ 0 (mod b), the rejected tail 2^32−limit < b, and every residue has exactly limit/b preimages. Then drive the reference shuffle with forced words: 0xFFFFFFFF first (must be rejected and consume an extra counter).', () => {
    const bounds = [], issues = [];
    let pAnyRejectionPerDeck = 0;
    for (let b = 2; b <= 20; b++) {
      const limit = Math.floor(TWO_32 / b) * b, tail = TWO_32 - limit;
      if (limit % b !== 0 || tail >= b || limit / b !== Math.floor(TWO_32 / b)) issues.push(b);
      pAnyRejectionPerDeck += tail / TWO_32;
      bounds.push({ bound: b, limit, rejectedValues: tail, rejectionProbability: tail / TWO_32 });
    }
    // Forced words: first draw 0xFFFFFFFF (rejected for every b that does not divide 2^32).
    const forced = [0xFFFFFFFF]; let calls = 0;
    const draw = () => { calls++; return forced.length ? forced.shift() : (calls * 2654435761) >>> 0; };
    const stats = {}; referenceShuffle(draw, stats);
    const forcedOk = stats.rejections === 1 && calls === 20;
    // Independent: a bound that divides 2^32 (b = 2, 4, 8, 16) can never reject.
    const powerOfTwoNoReject = [2, 4, 8, 16].every(b => Math.floor(TWO_32 / b) * b === TWO_32);
    const v = uniformBelow(20, (() => { const q = [4294967280, 4294967279]; return () => q.shift(); })());
    return { pass: issues.length === 0 && forcedOk && powerOfTwoNoReject && v === 4294967279 % 20, bounds, forcedFirstWordRejected: forcedOk, drawsConsumedWithOneRejection: calls,
      firstRejectedBound20Value: 4294967280, pAnyRejectionPerDeck,
      note: 'Natural rejections occur with probability ≈ ' + pAnyRejectionPerDeck.toExponential(3) + ' per deck, so they cannot be observed in practical samples; equivalence on natural data (R01) plus this forced-input test cover the path.' };
  });

await check('R04', 'Fisher–Yates form is a bijection between draw sequences and permutations', 'Descending i from n−1 to 1, j uniform in [0, i] (as implemented).',
  'Generalise the implemented loop to n = 1..8 and enumerate every possible draw sequence (n! of them); require n! distinct permutations. Also confirm n = 20 has 20!/(h!(20−h)!) equally weighted h-prefix sets by counting multiplicities for n = 8, h = 3.', () => {
    const rows = [];
    for (let n = 1; n <= 8; n++) {
      const seen = new Set(); let sequences = 0;
      const rec = (i, deck) => {
        if (i === 0) { sequences++; seen.add(deck.join(',')); return; }
        for (let j = 0; j <= i; j++) { const d = deck.slice(); [d[i], d[j]] = [d[j], d[i]]; rec(i - 1, d); }
      };
      rec(n - 1, Array.from({ length: n }, (_, i) => i + 1));
      rows.push({ n, sequences, distinctPermutations: seen.size, bijection: sequences === seen.size });
    }
    // Prefix-set multiplicity for n=8,h=3: each 3-subset should appear (8−3)!·3! times among 8! permutations.
    const counts = new Map();
    const rec = (i, deck) => { if (i === 0) { const k = deck.slice(0, 3).sort().join(','); counts.set(k, (counts.get(k) || 0) + 1); return; } for (let j = 0; j <= i; j++) { const d = deck.slice(); [d[i], d[j]] = [d[j], d[i]]; rec(i - 1, d); } };
    rec(7, [1, 2, 3, 4, 5, 6, 7, 8]);
    const mult = new Set(counts.values());
    return { pass: rows.every(r => r.bijection) && counts.size === 56 && mult.size === 1 && [...mult][0] === 720, rows, prefixSets: counts.size, prefixMultiplicity: [...mult] };
  });

await check('R05', 'HMAC message serialization is canonical and injective over stress inputs', 'JSON.stringify of a fixed-shape array is unambiguous.',
  'Compare production randomMessage() with the reference serializer for all stress seeds; verify field order; verify 8 seeds × 3 containers × 3 nonces × 3 counters produce 216 distinct messages; confirm a separator-injection seed cannot collide with a genuine field split.', () => {
    const msgs = new Set(); let equal = true;
    for (const cs of CLIENT_SEEDS) for (const c of CONTAINERS) for (const nonce of [0, 1, 10]) for (const counter of [0, 1, 19]) {
      const p = randomMessage(cs, nonce, c, counter), r = message(cs, nonce, c, counter).toString('utf8');
      if (p !== r) equal = false; msgs.add(p);
    }
    const injected = randomMessage('x","A', 0, 'B', 0) !== randomMessage('x', 0, 'A","B', 0);
    const shape = JSON.parse(randomMessage('s', 7, 'C', 3));
    const lone = randomMessage('\ud800', 0, 'A', 0);
    return { pass: equal && msgs.size === 216 && injected && JSON.stringify(shape) === JSON.stringify(['cargo-v1', 's', 7, 'C', 3]) && lone.includes('\\ud800'),
      distinctMessages: msgs.size, loneSurrogateSerializedAs: lone, note: 'Unpaired surrogates are escaped by JSON.stringify (ES2019 well-formed stringify), so Node createHmac and browser TextEncoder hash identical bytes.' };
  });

await check('R06', 'Seed commitment is SHA-256 over raw bytes; newSeed() emits 64 lowercase hex', 'docs/FAIRNESS.md §Commitment.',
  'Compare seedHash() with reference over 1,000 derived seeds and confirm it differs from hashing the hex text. Draw 10,000 production newSeed() values (non-deterministic) and check format and uniqueness only.', () => {
    let same = 0, textDiffers = 0;
    for (let i = 0; i < 1000; i++) { const s = derivedSeed('r06', i); if (seedHash(s) === referenceSeedHash(s)) same++; if (seedHash(s) !== createHash('sha256').update(s).digest('hex')) textDiffers++; }
    const seeds = Array.from({ length: 10000 }, newSeed), formatOk = seeds.every(s => /^[0-9a-f]{64}$/.test(s));
    return { pass: same === 1000 && textDiffers === 1000 && formatOk && new Set(seeds).size === 10000, hashesCompared: same, newSeedSamples: 10000, allFormatOk: formatOk, allUnique: new Set(seeds).size === 10000 };
  });

await check('R07', 'Difficulty is not part of the HMAC message: decks are nested across difficulties', 'Observation about the documented algorithm, not a defect by itself.',
  'For 1,000 (seed, nonce, container) tuples compute decks for h = 1, 3, 5, 10 and test Easy ⊂ Medium ⊂ Hard ⊂ Expert.', () => {
    let nested = 0;
    for (let i = 0; i < 1000; i++) {
      const seed = derivedSeed('r07', i), c = CONTAINERS[i % 3];
      const d = [1, 3, 5, 10].map(h => hazardDeck(seed, 'nest', i, c, h));
      if (d.every((deck, k) => k === 0 || d[k - 1].every(p => deck.includes(p)))) nested++;
    }
    return { pass: nested === 1000, tuples: 1000, nested,
      implication: 'Safe only because each committed server seed is consumed by exactly one round with one locked difficulty (verified in validate-system S05/S06). Any future feature that lets the same seed/nonce be replayed under a different difficulty would leak information across difficulties.' };
  });

await check('R08', 'Active-round responses never contain the server seed or hazard decks', 'publicRound()/snapshot() are the only public projections.',
  'For 400 deterministic engine rounds, serialise publicRound() after every action while active and search for the raw seed, its hazards key and every hazard array; require revelation after settlement.', () => {
    let activeSnapshots = 0; const leaks = []; let revealed = 0;
    for (let i = 0; i < 400; i++) {
      const m = modeKeys[i % 4], seed = derivedSeed('r08', i), s = createSession('r08', seed);
      const r = beginRound(s, { difficulty: m, stakeCents: 3000, clientSeed: 'leak', expectedSeedHash: seedHash(seed) }, derivedSeed('r08n', i));
      const inspect = () => { if (r.status !== 'active') return; activeSnapshots++; const j = JSON.stringify(publicRound(r));
        if (j.includes(seed) || j.includes('"hazards"') || j.includes('serverSeed"')) leaks.push({ i, step: r.step }); };
      inspect();
      while (r.status === 'active') { if (r.step === MODES[m].payouts.length) collectRound(s, r.id, 'all'); else advanceRound(s, r.id); inspect(); }
      const p = publicRound(r); if (p.proof.serverSeed === seed && p.proof.hazards) revealed++;
    }
    return { pass: leaks.length === 0 && revealed === 400, activeSnapshots, leaks: leaks.slice(0, 5), settledRevealed: revealed };
  });

// Known-answer vectors pinned for regression tests.
const vectors = [];
for (const m of modeKeys) for (const [label, seed] of [['zeros', '0'.repeat(64)], ['pattern', '0123456789abcdef'.repeat(4)], ['derived', derivedSeed('kat', m)]])
  for (const c of CONTAINERS) for (const [cs, nonce] of [['cargo-test', 0], ['🚢⚓️ cargo', 7], ['a","b\\"c', 123456]])
    vectors.push({ mode: m, seedLabel: label, serverSeed: seed, clientSeed: cs, nonce, containerId: c, hazards: MODES[m].hazards, deck: hazardDeck(seed, cs, nonce, c, MODES[m].hazards) });
fs.writeFileSync(new URL('./results/rng-vectors.json', import.meta.url), JSON.stringify({ note: 'Known-answer hazard decks from the unmodified production hazardDeck() at the audited commit. Used by audit/tests/rng.test.js.', count: vectors.length, vectors }, null, 1));

const failed = checks.filter(c => !c.pass);
fs.writeFileSync(outFile, JSON.stringify({ meta: { script: 'audit/validate-rng.mjs', node: process.version, generatedAt: new Date().toISOString(), runtimeMs: Date.now() - t0 },
  summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.map(c => c.id), knownAnswerVectors: vectors.length }, checks }, null, 1));
console.error(`${checks.length - failed.length}/${checks.length} RNG checks passed; ${vectors.length} known-answer vectors → ${outFile}`);
process.exitCode = failed.length ? 1 : 0;
