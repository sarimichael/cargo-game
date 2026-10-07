// F03 root-cause measurement: what the single session record is made of, and how request cost
// grows with it on both adapters. Synthetic play money only; timings are indicative (machine-dependent).
//
// Usage: node audit/measure-storage.mjs [--out audit/results/storage.json]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localAdapter, workerAdapter, startSession, bet, act, aid } from './lib/harness.mjs';

const arg = (n, f) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : f; };
const outFile = arg('out', fileURLToPath(new URL('./results/storage.json', import.meta.url)));
const bytes = v => Buffer.byteLength(JSON.stringify(v));
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// 1. Composition after ordinary play (Easy, minimum stake, sail once, collect if alive).
const w = await workerAdapter(), c = w.client(); await startSession(c);
const ROUNDS = 200;
for (let i = 0; i < ROUNDS; i++) {
  if (c.raw().balanceCents < 300) await act(c, '/api/reset');
  const b = await bet(c, { stakeCents: 300 }); await act(c, `/api/rounds/${b.body.round.id}/advance`);
  if (c.raw().rounds[b.body.round.id].status === 'active') await act(c, `/api/rounds/${b.body.round.id}/collect`, { containerId: 'all' });
}
const s = c.raw(), total = bytes(s);
const parts = { rounds: bytes(s.rounds), ledger: bytes(s.ledger), receipts: bytes(s.receipts) };
parts.other = total - parts.rounds - parts.ledger - parts.receipts;
const oneRound = Object.values(s.rounds)[0];
const roundParts = { events: bytes(oneRound.events), hazards: bytes(oneRound.hazards), containers: bytes(oneRound.containers), seedsAndProof: bytes([oneRound.serverSeed, oneRound.serverSeedHash, oneRound.clientSeed]) };
const composition = { rounds: ROUNDS, totalBytes: total, bytesPerRound: Math.round(total / ROUNDS),
  shares: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, { bytes: v, share: +(v / total).toFixed(3) }])),
  receiptsPerRound: +(Object.keys(s.receipts).length / ROUNDS).toFixed(2), ledgerEntriesPerRound: +(s.ledger.length / ROUNDS).toFixed(2),
  exampleRoundBytes: bytes(oneRound), exampleRoundParts: roundParts,
  retainedForever: ['every round including revealed seeds and full event logs', 'every ledger entry', 'every idempotency receipt'],
  snapshotResponseBytes: bytes((await c.get('/api/session')).body) };
const template = Object.values(s.rounds).find(r => r.status === 'settled');
await w.close();

// 2. Request cost vs stored size. Sessions are grown with cloned settled rounds (test-only fixture).
async function grow(client, target) {
  await client.mutate(st => {
    let i = 0; const per = bytes(template) + 40;
    while (bytes(st) + per < target) { const r = structuredClone(template); r.id = `00000000-0000-4000-8000-${String(i++).padStart(12, '0')}`; st.rounds[r.id] = r; if (i % 200 === 0 && bytes(st) + per >= target) break; }
  });
}
const sizes = [20000, 250000, 1000000, 1900000], latency = [];
for (const [kind, make] of [['worker', workerAdapter], ['local', localAdapter]]) {
  for (const target of sizes) {
    const a = await make(), cl = a.client(); await startSession(cl); await grow(cl, target);
    const actual = bytes(cl.raw()), gets = [], posts = [];
    for (let i = 0; i < 15; i++) { let t = performance.now(); await cl.get('/api/session'); gets.push(performance.now() - t);
      const st = (await cl.get('/api/session')).body; t = performance.now(); await cl.post('/api/reset', { revision: st.session.revision, actionId: aid('lat') }); posts.push(performance.now() - t); }
    latency.push({ adapter: kind, sessionBytes: actual, getSessionMs: +median(gets).toFixed(2), postActionMs: +median(posts).toFixed(2) });
    await a.close();
  }
}
const out = { meta: { script: 'audit/measure-storage.mjs', node: process.version, generatedAt: new Date().toISOString(), note: 'Timings are medians of 15 requests on this machine and only indicative; the in-memory SQLite stand-in has no network latency.' },
  composition, latency };
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.error(`composition: ${composition.bytesPerRound} B/round (rounds ${composition.shares.rounds.share}, receipts ${composition.shares.receipts.share}, ledger ${composition.shares.ledger.share}); latency rows: ${latency.length} → ${outFile}`);
