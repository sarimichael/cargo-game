// Deterministic Monte Carlo of the UNMODIFIED production hazardDeck().
//
// Usage: node audit/simulate.mjs [--rounds 1000000] [--threads 4] [--chunk 50000] [--out audit/results/simulation.json]
//
// Reproducibility: round i of mode m uses serverSeed = SHA-256("cargo-audit-v1|sim|m|i"),
// clientSeed = "audit-sim-m", nonce = i. Results are identical for any thread count
// because work is split into fixed nonce chunks and merged by chunk index.
// ASSUMPTION: derived seeds stand in for production newSeed(); see audit/lib/seeds.mjs.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const MODE_KEYS = ['easy', 'medium', 'hard', 'expert'];
const CONTAINERS = ['A', 'B', 'C'];

async function runChunk({ mode, start, end }) {
  const { hazardDeck } = await import('../server/fairness.js');
  const { MODES } = await import('../public/math.js');
  const { referenceHazardDeck } = await import('./lib/reference-rng.mjs');
  const { derivedSeed } = await import('./lib/seeds.mjs');
  const h = MODES[mode].hazards, N = MODES[mode].payouts.length, clientSeed = 'audit-sim-' + mode;
  const zeros = n => Array(n).fill(0);
  const out = {
    mode, start, end, invalidDecks: 0, referenceChecked: 0, referenceMismatches: 0,
    countsK: Array.from({ length: N + 1 }, () => zeros(4)),           // [stop][k survivors]
    positions: CONTAINERS.map(() => zeros(21)),                        // [container][position]
    firstHazard: CONTAINERS.map(() => zeros(21)),                      // [container][min position]
    pairs: { AB: Array.from({ length: 21 }, () => zeros(21)), AC: Array.from({ length: 21 }, () => zeros(21)), BC: Array.from({ length: 21 }, () => zeros(21)) },
    decks: {}, lag: { n: 0, sx: 0, sy: 0, sxy: 0, sxx: 0, syy: 0 }, adjacentRepeatsA: 0, adjacentPairs: 0
  };
  const digest = createHash('sha256');
  let prevFirst = null, prevKey = null;
  for (let i = start; i < end; i++) {
    const seed = derivedSeed('sim|' + mode, i);
    const decks = CONTAINERS.map(c => hazardDeck(seed, clientSeed, i, c, h));
    if (i % 100 === 0) {
      out.referenceChecked++;
      CONTAINERS.forEach((c, k) => { if (JSON.stringify(referenceHazardDeck(seed, clientSeed, i, c, h)) !== JSON.stringify(decks[k])) out.referenceMismatches++; });
    }
    const firsts = decks.map(d => {
      const ok = d.length === h && new Set(d).size === h && d.every((p, j) => Number.isInteger(p) && p >= 1 && p <= 20 && (j === 0 || d[j - 1] < p));
      if (!ok) out.invalidDecks++;
      return d[0];
    });
    decks.forEach((d, k) => { for (const p of d) out.positions[k][p]++; out.firstHazard[k][d[0]]++; });
    out.pairs.AB[firsts[0]][firsts[1]]++; out.pairs.AC[firsts[0]][firsts[2]]++; out.pairs.BC[firsts[1]][firsts[2]]++;
    for (let s = 1; s <= N; s++) out.countsK[s][(firsts[0] > s) + (firsts[1] > s) + (firsts[2] > s)]++;
    const keyA = decks[0].join(',');
    if (h <= 3) for (const d of decks) { const key = d.join(','); out.decks[key] = (out.decks[key] || 0) + 1; }
    if (prevFirst !== null) {
      const x = prevFirst, y = firsts[0], L = out.lag;
      L.n++; L.sx += x; L.sy += y; L.sxy += x * y; L.sxx += x * x; L.syy += y * y;
      out.adjacentPairs++; if (keyA === prevKey) out.adjacentRepeatsA++;
    }
    prevFirst = firsts[0]; prevKey = keyA;
    digest.update(decks.map(d => d.join(',')).join('|') + ';');
  }
  out.streamHash = digest.digest('hex');
  return out;
}

if (!isMainThread) {
  parentPort.on('message', async task => parentPort.postMessage(await runChunk(task)));
} else {
  const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
  const rounds = Number(arg('rounds', 1000000)), chunk = Number(arg('chunk', 50000));
  const threads = Math.max(1, Math.min(Number(arg('threads', os.availableParallelism?.() || 4)), 16));
  const outFile = arg('out', fileURLToPath(new URL('./results/simulation-raw.json', import.meta.url)));
  const tasks = [];
  for (const mode of MODE_KEYS) for (let s = 0; s < rounds; s += chunk) tasks.push({ mode, start: s, end: Math.min(rounds, s + chunk) });
  const startedAt = new Date().toISOString(), t0 = Date.now(), results = new Array(tasks.length);
  let next = 0, done = 0;
  await new Promise((resolve, reject) => {
    for (let w = 0; w < Math.min(threads, tasks.length); w++) {
      const worker = new Worker(fileURLToPath(import.meta.url));
      const feed = () => { if (next < tasks.length) { worker.currentTask = next; worker.postMessage(tasks[next++]); } else worker.terminate(); };
      worker.on('message', r => {
        results[worker.currentTask] = r; done++;
        if (done % 8 === 0 || done === tasks.length) console.error(`chunks ${done}/${tasks.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
        if (done === tasks.length) resolve(); feed();
      });
      worker.on('error', reject); feed();
    }
  });
  // Merge in fixed chunk order.
  const merged = {};
  for (const r of results) {
    const m = merged[r.mode] ??= { rounds: 0, invalidDecks: 0, referenceChecked: 0, referenceMismatches: 0, countsK: r.countsK.map(x => x.map(() => 0)),
      positions: r.positions.map(x => x.map(() => 0)), firstHazard: r.firstHazard.map(x => x.map(() => 0)),
      pairs: Object.fromEntries(Object.entries(r.pairs).map(([k, t]) => [k, t.map(x => x.map(() => 0))])), decks: {},
      lag: { n: 0, sx: 0, sy: 0, sxy: 0, sxx: 0, syy: 0 }, adjacentRepeatsA: 0, adjacentPairs: 0, chunkHashes: [] };
    m.rounds += r.end - r.start;
    for (const k of ['invalidDecks', 'referenceChecked', 'referenceMismatches', 'adjacentRepeatsA', 'adjacentPairs']) m[k] += r[k];
    r.countsK.forEach((row, s) => row.forEach((v, k) => { m.countsK[s][k] += v; }));
    for (const f of ['positions', 'firstHazard']) r[f].forEach((row, c) => row.forEach((v, p) => { m[f][c][p] += v; }));
    for (const [k, t] of Object.entries(r.pairs)) t.forEach((row, i) => row.forEach((v, j) => { m.pairs[k][i][j] += v; }));
    for (const [k, v] of Object.entries(r.decks)) m.decks[k] = (m.decks[k] || 0) + v;
    for (const k of Object.keys(m.lag)) m.lag[k] += r.lag[k];
    m.chunkHashes.push(r.streamHash);
  }
  for (const m of Object.values(merged)) m.streamHash = createHash('sha256').update(m.chunkHashes.join('')).digest('hex');
  const meta = { script: 'audit/simulate.mjs', node: process.version, roundsPerMode: rounds, chunk, threads, startedAt, finishedAt: new Date().toISOString(),
    seedDerivation: 'serverSeed=SHA256("cargo-audit-v1|sim|<mode>|<i>") hex; clientSeed="audit-sim-<mode>"; nonce=i',
    note: 'Lag-1 statistics and adjacent repeats are computed within chunks only; chunk boundaries are excluded.' };
  fs.mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ meta, modes: merged }));
  console.error(`wrote ${outFile} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
