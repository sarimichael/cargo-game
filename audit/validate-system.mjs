// Adversarial system validation of the REAL local HTTP adapter and the REAL hosted
// Worker adapter (in-memory SQLite), plus engine-level defect reproductions.
//
// Usage: node audit/validate-system.mjs [--out audit/results/system.json] [--skip-capacity]
//
// Result semantics:
//   type "safety"     – pass means the protective property HELD.
//   type "remediated" – a previously reported defect that phase 2 fixed; pass means the
//                       corrected behaviour HELD (the defect no longer reproduces).
//   type "mitigated"  – the harmful consequence is prevented but the root cause is open.
//   type "defect"     – pass means the previously reported defect still REPRODUCES
//                       exactly as described (a reproduction is not a safety pass).
//   type "observation" – recorded behaviour with no pass/fail judgement implied.
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, aid, startSession, bet, act, ledgerInvariant, localAdapter, workerAdapter } from './lib/harness.mjs';
import { Store } from '../server/store.js';
import { MODES, payout, multiplier, splitStake } from '../public/math.js';
import { createSession, beginRound, advanceRound, collectRound, publicRound } from '../server/game.js';
import { seedHash } from '../server/fairness.js';
import { verifyRound } from '../public/fairness.js';
import { collisionFor } from '../public/collision.js';
import { derivedSeed, splitmix } from './lib/seeds.mjs';

const arg = (n, f) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : f; };
const outFile = arg('out', fileURLToPath(new URL('./results/system.json', import.meta.url)));
const checks = [], t0 = Date.now();
async function check(id, type, title, assumption, method, fn) {
  const started = Date.now(); let result;
  try { result = await fn(); } catch (error) { result = { pass: false, error: error.stack }; }
  checks.push({ id, type, title, assumption, method, ...result, ms: Date.now() - started });
  console.error(`${result.pass ? 'PASS' : 'FAIL'} ${id} [${type}] ${title} (${Date.now() - started} ms)`);
}
async function perAdapter(fn) {
  const out = {};
  for (const [kind, make] of Object.entries(ADAPTERS)) { const a = await make(); try { out[kind] = await fn(a, a.client()); } finally { await a.close(); } }
  return { pass: Object.values(out).every(r => r.ok), adapters: out };
}
const forceHazards = (c, map) => c.mutate(s => { s.rounds[s.currentRoundId].hazards = map; });
const safeHazards = { A: [20], B: [20], C: [20] };

await check('S01', 'safety', '20 concurrent identical bet requests debit once', 'Clients retry with the exact same actionId and body.',
  'Fire 20 identical POST /api/rounds in parallel; count successful responses, replays, ledger bet entries and balance.', () => perAdapter(async (a, c) => {
    const s = await startSession(c), body = { difficulty: 'easy', stakeCents: 3000, clientSeed: 'dup', expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('dupbet') };
    const rs = await Promise.all(Array.from({ length: 20 }, () => c.post('/api/rounds', body)));
    const raw = c.raw(), bets = raw.ledger.filter(e => e.kind === 'bet').length;
    return { ok: rs.every(r => r.status === 200) && bets === 1 && raw.balanceCents === 97000 && rs.filter(r => r.body.replayed).length === 19, statuses: [...new Set(rs.map(r => r.status))], replayed: rs.filter(r => r.body.replayed).length, betEntries: bets, balance: raw.balanceCents };
  }));

await check('S02', 'safety', '20 concurrent bets with distinct actionIds and the same revision: exactly one succeeds', 'Revision compare-and-swap serialises competing actions.',
  'Fire 20 different-ID bets at revision 0 in parallel.', () => perAdapter(async (a, c) => {
    const s = await startSession(c);
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => c.post('/api/rounds', { difficulty: 'easy', stakeCents: 3000 + i, clientSeed: 'c', expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('race') })));
    const ok200 = rs.filter(r => r.status === 200).length, raw = c.raw();
    return { ok: ok200 === 1 && rs.filter(r => r.status === 409).length === 19 && raw.ledger.length === 1, successes: ok200, conflicts: rs.filter(r => r.status === 409).length, ledgerEntries: raw.ledger.length };
  }));

await check('S03', 'safety', '20 concurrent identical advance requests advance one stop', 'As S01.', 'Bet with hazards forced safe; fire 20 identical advances.', () => perAdapter(async (a, c) => {
    const b = await bet(c); await forceHazards(c, safeHazards);
    const body = { revision: b.body.session.revision, actionId: aid('adv') }, id = b.body.round.id;
    const rs = await Promise.all(Array.from({ length: 20 }, () => c.post(`/api/rounds/${id}/advance`, body)));
    const raw = c.raw(), r = raw.rounds[id];
    return { ok: r.step === 1 && r.events.filter(e => e.kind === 'sail').length === 1 && rs.every(x => x.status === 200), step: r.step, statuses: [...new Set(rs.map(x => x.status))] };
  }));

await check('S04', 'safety', '50 concurrent identical collect-all requests credit each container once', 'As S01.', 'Bet $30.01, force safe stop 1, advance, then 50 identical collect-all.', () => perAdapter(async (a, c) => {
    const b = await bet(c, { stakeCents: 3001 }); await forceHazards(c, safeHazards);
    const adv = await act(c, `/api/rounds/${b.body.round.id}/advance`);
    const body = { revision: adv.body.session.revision, actionId: aid('col'), containerId: 'all' };
    const rs = await Promise.all(Array.from({ length: 50 }, () => c.post(`/api/rounds/${b.body.round.id}/collect`, body)));
    const raw = c.raw(), credits = raw.ledger.filter(e => e.kind === 'collect'), expected = splitStake(3001).reduce((x, w) => x + payout(w, 103), 0);
    return { ok: credits.length === 3 && credits.reduce((x, e) => x + e.amountCents, 0) === expected && raw.balanceCents === 100000 - 3001 + expected && ledgerInvariant(raw).ok, creditEntries: credits.length, credited: credits.reduce((x, e) => x + e.amountCents, 0), expected };
  }));

await check('S05', 'safety', 'Cash-out racing an eliminating advance: exactly one wins, no double outcome', 'The next stop is forced (test fixture) to eliminate all onboard cargo.',
  '40 trials per adapter: after stop 1, force stop 2 to hit every container, then send collect-all and advance concurrently with the same revision.', () => perAdapter(async (a) => {
    const tally = { collectWon: 0, advanceWon: 0, bad: 0 };
    for (let i = 0; i < 40; i++) {
      const c = a.client(); const b = await bet(c, { difficulty: 'medium' }); await forceHazards(c, { A: [2], B: [2], C: [2] });
      const adv = await act(c, `/api/rounds/${b.body.round.id}/advance`), rev = adv.body.session.revision, id = b.body.round.id;
      const order = i % 2 ? ['collect', 'advance'] : ['advance', 'collect'];
      const rs = await Promise.all(order.map(k => k === 'collect' ? c.post(`/api/rounds/${id}/collect`, { revision: rev, actionId: aid('rc'), containerId: 'all' }) : c.post(`/api/rounds/${id}/advance`, { revision: rev, actionId: aid('ra') })));
      const raw = c.raw(), r = raw.rounds[id], statuses = rs.map(x => x.status).sort().join(',');
      const allCollected = r.containers.every(x => x.status === 'collected'), allLost = r.containers.every(x => x.status === 'lost');
      if (statuses !== '200,409' || !(allCollected || allLost) || !ledgerInvariant(raw).ok || r.status !== 'settled') tally.bad++;
      else if (allCollected) tally.collectWon++; else tally.advanceWon++;
    }
    return { ok: tally.bad === 0, ...tally };
  }));

await check('S06', 'safety', 'Forged financial fields in requests are ignored', 'The server must not trust client-supplied outcomes.',
  'Add multiplier100, payoutCents, balanceCents, hazards, step, status, serverSeed and a different difficulty to bet/advance/collect bodies; compare credited amounts with the server formula.', () => perAdapter(async (a, c) => {
    const s = await startSession(c), forged = { multiplier100: 18106088, payoutCents: 99999999, balanceCents: 99999999, hazards: { A: [], B: [], C: [] }, step: 10, status: 'settled', serverSeed: '0'.repeat(64), returnedCents: 1e9 };
    const b = await c.post('/api/rounds', { ...forged, difficulty: 'easy', stakeCents: 3000, clientSeed: 'f', expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('fb') });
    await forceHazards(c, safeHazards);
    const id = b.body.round.id, adv = await c.post(`/api/rounds/${id}/advance`, { ...forged, revision: 1, actionId: aid('fa') });
    const col = await c.post(`/api/rounds/${id}/collect`, { ...forged, difficulty: 'expert', containerId: 'all', revision: 2, actionId: aid('fc') });
    const raw = c.raw(), r = raw.rounds[id];
    return { ok: b.status === 200 && adv.status === 200 && col.status === 200 && r.difficulty === 'easy' && r.step === 1 && raw.balanceCents === 97000 + 3 * payout(1000, 103) && ledgerInvariant(raw).ok, balance: raw.balanceCents, expected: 97000 + 3 * payout(1000, 103) };
  }));

await check('S07', 'safety', 'Invalid wagers, difficulties and client seeds are rejected without persisted change', 'Server-side validation is authoritative.',
  'Submit 28 malformed bets; compare the stored session JSON before and after each.', () => perAdapter(async (a, c) => {
    const s = await startSession(c), base = { difficulty: 'easy', stakeCents: 3000, clientSeed: 'v', expectedSeedHash: s.session.nextSeedHash, revision: 0 };
    const cases = [...[0, -1, 299, 300001, 300.5, 1e21, -0.5, '3000', null, true, [], {}, 'NaN', Number.MAX_SAFE_INTEGER + 2].map(v => ({ stakeCents: v })), { stakeCents: 100001 },
      ...['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'EASY', '', 'easy '].map(v => ({ difficulty: v })),
      { clientSeed: '' }, { clientSeed: 'a'.repeat(129) }, { clientSeed: 5 }, { clientSeed: null }, { expectedSeedHash: 'stale' }, { expectedSeedHash: undefined }];
    const failures = []; let rejected = 0;
    for (const change of cases) {
      const before = JSON.stringify(c.raw()), r = await c.post('/api/rounds', { ...base, ...change, actionId: aid('inv') });
      if (r.status >= 400 && r.status < 500) rejected++; else failures.push({ change, status: r.status });
      if (JSON.stringify(c.raw()) !== before) failures.push({ change, issue: 'state changed' });
    }
    return { ok: failures.length === 0 && rejected === cases.length, cases: cases.length, rejected, failures };
  }));

await check('S08', 'safety', 'Protocol validation: action IDs, revisions, body shape, size, content type, origin and routes', 'docs/API.md error contract.',
  'Send each malformed request and compare the HTTP status with the documented code.', () => perAdapter(async (a, c) => {
    const s = await startSession(c), rev = s.session.revision, results = [];
    const expect = async (label, status, p) => { const r = await p; results.push({ label, expected: status, got: r.status }); };
    for (const id of ['short', 'x'.repeat(81), 'has space-1', 'semi;colon1', 12345678, null, '../../etc12']) await expect(`actionId ${JSON.stringify(id)}`, 400, c.post('/api/reset', { revision: rev, actionId: id }));
    for (const r of ['1', 1.5, null, undefined, 2 ** 53]) await expect(`revision ${JSON.stringify(r)}`, 400, c.post('/api/reset', { revision: r, actionId: aid('rv') }));
    await expect('JSON array body', 400, c.post('/api/reset', null, {}, '[1,2]'));
    await expect('invalid JSON', 400, c.post('/api/reset', null, {}, '{"a":'));
    await expect('oversized body', 413, c.post('/api/reset', { revision: rev, actionId: aid('big'), pad: 'x'.repeat(17000) }));
    await expect('wrong content type', 415, c.post('/api/reset', { revision: rev, actionId: aid('ct') }, { 'Content-Type': 'text/plain' }));
    await expect('cross-origin', 403, c.post('/api/reset', { revision: rev, actionId: aid('co') }, { Origin: 'https://evil.example' }));
    await expect('sec-fetch-site cross-site', 403, c.post('/api/reset', { revision: rev, actionId: aid('cs') }, { 'Sec-Fetch-Site': 'cross-site' }));
    await expect('unknown POST route', 404, c.post('/api/nope', { revision: rev, actionId: aid('nr') }));
    await expect('no session cookie', 401, c.fork().post('/api/reset', { revision: 0, actionId: aid('ns') }));
    const b = await bet(c);
    await expect('collect at stop zero', 409, c.post(`/api/rounds/${b.body.round.id}/collect`, { revision: b.body.session.revision, actionId: aid('z'), containerId: 'all' }));
    await expect('invalid container', 400, (async () => { await forceHazards(c, safeHazards); const adv = await act(c, `/api/rounds/${b.body.round.id}/advance`); return c.post(`/api/rounds/${b.body.round.id}/collect`, { revision: adv.body.session.revision, actionId: aid('ic'), containerId: 'D' }); })());
    const other = c.fork(); await startSession(other);
    await expect('foreign round GET', 404, other.get(`/api/rounds/${b.body.round.id}`));
    await expect('foreign round advance', 404, (async () => { const so = (await other.get('/api/session')).body; return other.post(`/api/rounds/${b.body.round.id}/advance`, { revision: so.session.revision, actionId: aid('fa') }); })());
    const bad = results.filter(r => r.expected !== r.got);
    return { ok: bad.length === 0, cases: results.length, mismatches: bad };
  }));

await check('S09', 'safety', 'No active-round HTTP response contains the server seed or hazards', 'publicRound()/snapshot() are the only projections.',
  '30 rounds per adapter; after each action capture session GET, round GET, POST response and an exact replay; search each whole response for the stored seed string and the round proof for serverSeed/hazards keys.', () => perAdapter(async (a, c) => {
    let inspected = 0; const leaks = [];
    for (let i = 0; i < 30; i++) {
      const b = await bet(c, { difficulty: Object.keys(MODES)[i % 4] }), id = b.body.round.id;
      const seed = c.raw().rounds[id].serverSeed;
      // config.modes[*].hazards is the public hazard COUNT, so only the round proof is searched for a "hazards" key.
      const scan = (label, r) => { if (r.body?.round?.status !== 'active') return; inspected++; const j = JSON.stringify(r.body); if (j.includes(seed) || 'hazards' in (r.body.round.proof || {}) || 'serverSeed' in (r.body.round.proof || {})) leaks.push({ i, label }); };
      scan('bet', b);
      while (c.raw().rounds[id].status === 'active') {
        const st = (await c.get('/api/session')).body; scan('session', { body: st }); scan('round', await c.get('/api/rounds/' + id));
        const route = st.round.step === st.round.maxStops ? 'collect' : 'advance', body = { revision: st.session.revision, actionId: aid('s9'), ...(route === 'collect' ? { containerId: 'all' } : {}) };
        const r = await c.post(`/api/rounds/${id}/${route}`, body); scan(route, r); scan('replay', await c.post(`/api/rounds/${id}/${route}`, body));
      }
      const settled = (await c.get('/api/rounds/' + id)).body.round;
      if (settled.proof.serverSeed !== seed) leaks.push({ i, issue: 'not revealed after settlement' });
      if (c.raw().balanceCents < 3000) await act(c, '/api/reset');
    }
    return { ok: leaks.length === 0, inspectedActiveResponses: inspected, leaks };
  }));

const campaignRounds = [];
await check('S10', 'safety', 'Mixed-strategy campaign: ledger, settlement formula, proofs and collision mapping reconcile', 'Server outcomes are authoritative; animation follows them.',
  '80 rounds per adapter with a deterministic action policy (random collections of individual containers, collect-all, sail). After every sail compare collisionFor(previous, next) with the server statuses. After settlement verify each credit equals payout(stake, multiplier at collectedAt), run verifyRound(), and check start + Σledger = balance.', () => perAdapter(async (a, c) => {
    const rng = splitmix('S10|' + a.kind), issues = []; let rounds = 0, sails = 0, icebergs = 0, debris = 0, verified = 0;
    await startSession(c);
    for (let i = 0; i < 80; i++) {
      const mode = rng.pick(Object.keys(MODES)), stake = 300 + rng.int(5000);
      if (c.raw().balanceCents < stake) await act(c, '/api/reset');
      let st = (await bet(c, { difficulty: mode, stakeCents: stake, clientSeed: 'camp-' + i })).body; const id = st.round.id; rounds++;
      while (st.round.status === 'active') {
        const onboard = st.round.containers.filter(x => x.status === 'onboard').map(x => x.id), choice = rng.int(10);
        let r;
        if (st.round.step >= 1 && (st.round.step === st.round.maxStops || choice < 2)) r = await c.post(`/api/rounds/${id}/collect`, { revision: st.session.revision, actionId: aid('cc'), containerId: rng.pick([...onboard, 'all']) });
        else {
          r = await c.post(`/api/rounds/${id}/advance`, { revision: st.session.revision, actionId: aid('cs') }); sails++;
          const col = collisionFor(st.round, r.body.round), newlyLost = r.body.round.containers.filter((x, k) => x.status === 'lost' && st.round.containers[k].status === 'onboard').map(x => x.id);
          const allLost = r.body.round.containers.every(x => x.status === 'lost');
          const expected = newlyLost.length === 0 ? null : allLost ? 'iceberg' : 'debris';
          if ((col?.kind ?? null) !== expected || JSON.stringify(col?.lost ?? []) !== JSON.stringify(newlyLost)) issues.push({ i, issue: 'collision mapping', col, newlyLost });
          if (expected === 'iceberg') icebergs++; if (expected === 'debris') debris++;
        }
        if (r.status !== 200) { issues.push({ i, status: r.status, body: r.body }); break; }
        st = r.body;
      }
      const round = st.round;
      for (const x of round.containers) {
        if (x.status === 'collected' && x.payoutCents !== payout(x.stakeCents, multiplier(mode, x.collectedAt))) issues.push({ i, issue: 'payout formula', x });
        if (x.status === 'lost' && x.payoutCents !== 0) issues.push({ i, issue: 'lost cargo paid' });
      }
      if (round.returnedCents !== round.containers.reduce((s, x) => s + x.payoutCents, 0)) issues.push({ i, issue: 'returned total' });
      if ((await verifyRound(round)).valid) verified++; else issues.push({ i, issue: 'proof' });
      campaignRounds.push({ adapter: a.kind, mode, stake, step: round.step, statuses: round.containers.map(x => x.status).join(''), returned: round.returnedCents });
    }
    const inv = ledgerInvariant(c.raw()); if (!inv.ok) issues.push({ issue: 'ledger', inv });
    return { ok: issues.length === 0, rounds, sails, icebergs, debris, proofsVerified: verified, ledger: inv, issues: issues.slice(0, 10) };
  }));

await check('S11', 'safety', 'Client disconnect immediately after sending a bet, then exact retry: one debit (local HTTP)', 'Clients retry uncertain requests with the same body and actionId.',
  '10 trials: write the request over a raw socket and destroy it straight away; then retry the identical request via fetch and inspect the ledger.', async () => {
    const a = await localAdapter(); const trials = [];
    try {
      for (let i = 0; i < 10; i++) {
        const c = a.client(), s = await startSession(c), body = JSON.stringify({ difficulty: 'easy', stakeCents: 3000, clientSeed: 'dc', expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('dc') });
        await new Promise(resolve => { const req = http.request(a.url + '/api/rounds', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c.jar.header(), Origin: a.url, 'Content-Length': Buffer.byteLength(body) } });
          req.on('error', () => resolve()); req.end(body, () => { setTimeout(() => { req.destroy(); resolve(); }, i % 2 ? 0 : 5); }); });
        await new Promise(r => setTimeout(r, 20));
        const committedBefore = c.raw().ledger.length === 1;
        const retry = await c.post('/api/rounds', null, {}, body), raw = c.raw();
        trials.push({ committedBeforeRetry: committedBefore, retryStatus: retry.status, replayed: !!retry.body.replayed, betEntries: raw.ledger.filter(e => e.kind === 'bet').length });
      }
    } finally { await a.close(); }
    return { pass: trials.every(t => t.retryStatus === 200 && t.betEntries === 1 && t.replayed === t.committedBeforeRetry), trials };
  });

await check('S12', 'safety', 'Storage failures before/after commit: no partial effect; exact retry is safe', 'Fault injected in fs.writeFileSync (local) or the SQLite stand-in (worker); production code unchanged.',
  'Local: throw once from writeFileSync during a bet. Worker: throw once before UPDATE, and once after UPDATE has committed. Then retry the identical request.', async () => {
    const out = {};
    { const a = await localAdapter(); try {
      const c = a.client(), s = await startSession(c), before = JSON.stringify(a.store.state), disk = fs.readFileSync(a.directory + '/state.json', 'utf8');
      const original = fs.writeFileSync; let armed = true;
      fs.writeFileSync = function (file, ...rest) { if (armed && /state\.json(\.[0-9a-f]{12})?\.tmp$/.test(String(file))) { armed = false; throw new Error('injected disk failure'); } return original.call(this, file, ...rest); };
      const body = { difficulty: 'easy', stakeCents: 3000, clientSeed: 'f', expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('fi') };
      let first; try { first = await c.post('/api/rounds', body); } finally { fs.writeFileSync = original; }
      const unchanged = JSON.stringify(a.store.state) === before && fs.readFileSync(a.directory + '/state.json', 'utf8') === disk;
      const retry = await c.post('/api/rounds', body);
      out.local = { ok: first.status === 500 && unchanged && retry.status === 200 && !retry.body.replayed && c.raw().ledger.length === 1, firstStatus: first.status, stateUnchanged: unchanged, retryStatus: retry.status };
    } finally { await a.close(); } }
    { const a = await workerAdapter(); try {
      const c = a.client(), s = await startSession(c);
      const body = { difficulty: 'easy', stakeCents: 3000, clientSeed: 'f', expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('wf') };
      a.faults.beforeUpdate = 1; const first = await c.post('/api/rounds', body); const unchanged = c.raw().ledger.length === 0;
      const retry = await c.post('/api/rounds', body);
      a.faults.afterUpdate = 1; await forceHazards(c, safeHazards);
      const advBody = { revision: retry.body.session.revision, actionId: aid('wa') }, adv = await c.post(`/api/rounds/${retry.body.round.id}/advance`, advBody);
      const advRetry = await c.post(`/api/rounds/${retry.body.round.id}/advance`, advBody), raw = c.raw();
      out.worker = { ok: first.status === 500 && unchanged && retry.status === 200 && adv.status === 500 && advRetry.status === 200 && advRetry.body.replayed === true && raw.rounds[retry.body.round.id].step === 1,
        beforeUpdate: { status: first.status, unchanged, retry: retry.status }, afterUpdate: { status: adv.status, retry: advRetry.status, replayed: advRetry.body.replayed, step: raw.rounds[retry.body.round.id].step } };
    } finally { await a.close(); } }
    return { pass: out.local.ok && out.worker.ok, adapters: out };
  });

await check('S13', 'remediated', 'F10 fixed: prototype-named action IDs and reordered JSON keys replay correctly', 'Reported in audit F10; fixed in phase 2 (server/protocol.js).',
  'Fresh session: POST /api/reset with actionId "constructor" twice (must execute once, then replay). Replay a completed collect with its keys reordered (must replay), then reuse the ID with a different container (must still be refused).', () => perAdapter(async (a, c) => {
    const s = await startSession(c);
    const ctor = await c.post('/api/reset', { revision: s.session.revision, actionId: 'constructor' });
    const ctorAgain = await c.post('/api/reset', { revision: s.session.revision, actionId: 'constructor' });
    const b = await bet(c); await forceHazards(c, safeHazards); const adv = await act(c, `/api/rounds/${b.body.round.id}/advance`);
    const id = aid('ord'), rev = adv.body.session.revision;
    const first = await c.post(`/api/rounds/${b.body.round.id}/collect`, { revision: rev, actionId: id, containerId: 'all' });
    const reordered = await c.post(`/api/rounds/${b.body.round.id}/collect`, { containerId: 'all', actionId: id, revision: rev });
    const different = await c.post(`/api/rounds/${b.body.round.id}/collect`, { revision: rev, actionId: id, containerId: 'A' });
    const credits = c.raw().ledger.filter(e => e.kind === 'collect').length;
    return { ok: ctor.status === 200 && ctorAgain.body?.replayed === true && first.status === 200 && reordered.status === 200 && reordered.body.replayed === true && different.status === 409 && credits === 3,
      constructorFirst: ctor.status, constructorReplay: ctorAgain.body?.replayed, reorderedReplay: reordered.status, differentBodySameId: different.status, creditsAfter: credits };
  }));

await check('S14', 'defect', 'F01/F09: free funding — reset restores $1,000 after a loss; every cookieless GET creates a funded session', 'Reported in audit F01 and F09.',
  'Lose a $3.01 round (forced), POST /api/reset; then issue 25 cookieless GET /api/session and count stored sessions.', () => perAdapter(async (a, c) => {
    const b = await bet(c, { stakeCents: 301 }); await forceHazards(c, { A: [1], B: [1], C: [1] }); await act(c, `/api/rounds/${b.body.round.id}/advance`);
    const lost = c.raw().balanceCents; const reset = await act(c, '/api/reset'); const after = c.raw().balanceCents;
    const before = a.sessionCount(); for (let i = 0; i < 25; i++) await a.client().get('/api/session');
    return { ok: lost === 99699 && reset.status === 200 && after === 100000 && a.sessionCount() - before === 25, balanceAfterLoss: lost, balanceAfterReset: after, newSessionsFrom25Gets: a.sessionCount() - before };
  }));

await check('S15', 'mitigated', 'F03 mitigated: near the D1 row limit new bets are refused cleanly and every accepted round settles', 'Cloudflare D1 documents a 2,000,000-byte maximum string/BLOB/row; emulated in the SQLite stand-in. Root cause (unbounded session growth) is still open.',
  'Play minimum-stake Easy rounds through the real Worker under the emulated limit. Once within two reserves of the limit, switch to worst-case rounds (19 stops, three separate collections, 80-character action IDs). Continue until a bet is refused; require that no request ever fails with 500, the refusal is 409 SESSION_STORAGE_FULL, and every accepted round settled. Separately measure bytes per round on the local store.', async () => {
    if (process.argv.includes('--skip-capacity')) return { pass: true, skipped: true, note: 'Run without --skip-capacity for the full measurement.' };
    const { MAX_SESSION_BODY_BYTES, SETTLEMENT_RESERVE_BYTES } = await import('../server/protocol.js');
    const a = await workerAdapter({ maxBodyBytes: MAX_SESSION_BODY_BYTES }), c = a.client();
    let rounds = 0, worstCaseRounds = 0, refusal = null; const errors = [], unsettled = [];
    const longId = p => (p + '-' + aid('w')).padEnd(80, 'x').slice(0, 80);
    try {
      await startSession(c);
      for (;;) {
        let st = (await c.get('/api/session')).body;
        if (st.session.balanceCents < 300) { const r = await c.post('/api/reset', { revision: st.session.revision, actionId: aid('cr') }); if (r.status !== 200) { errors.push({ action: 'reset', status: r.status }); break; } st = r.body; }
        const worst = c.rawBytes() > MAX_SESSION_BODY_BYTES - 2 * SETTLEMENT_RESERVE_BYTES;
        const b = await c.post('/api/rounds', { difficulty: 'easy', stakeCents: 300, clientSeed: worst ? '\u0001'.repeat(128) : 'cap', expectedSeedHash: st.session.nextSeedHash, revision: st.session.revision, actionId: worst ? longId('b') : aid('cb') });
        if (b.status !== 200) { refusal = { status: b.status, code: b.body?.code, bytes: c.rawBytes(), headroomBytes: MAX_SESSION_BODY_BYTES - c.rawBytes() }; if (b.status === 500) errors.push({ action: 'bet', status: 500 }); break; }
        st = b.body; const id = st.round.id;
        if (worst) { await forceHazards(c, safeHazards); worstCaseRounds++; }
        let step = 0; const collectedAt = new Set();
        while (st.round.status === 'active') {
          step++;
          const collect = worst ? [6, 12, 19].includes(st.round.step) && !collectedAt.has(st.round.step) : st.round.step >= 1;
          if (collect) collectedAt.add(st.round.step);
          const target = worst ? ({ 6: 'A', 12: 'B', 19: 'C' })[st.round.step] : 'all';
          const route = collect ? 'collect' : 'advance';
          const r = await c.post(`/api/rounds/${id}/${route}`, { revision: st.session.revision, actionId: worst ? longId(route[0] + step) : aid('cx'), ...(collect ? { containerId: target } : {}) });
          if (r.status !== 200) { errors.push({ action: route, status: r.status, bytes: c.rawBytes() }); break; }
          st = r.body;
        }
        if (c.raw().rounds[id].status !== 'settled') { unsettled.push(id); break; }
        rounds++;
        if (rounds > 5000) break;
      }
    } finally { await a.close(); }
    const l = await localAdapter(); let perRound;
    try { const c2 = l.client(); await startSession(c2); const size = () => fs.statSync(l.directory + '/state.json').size; const s0 = size();
      for (let i = 0; i < 50; i++) { const b = await bet(c2, { stakeCents: 300 }); await act(c2, `/api/rounds/${b.body.round.id}/advance`); if (c2.raw().rounds[b.body.round.id].status === 'active') await act(c2, `/api/rounds/${b.body.round.id}/collect`, { containerId: 'all' }); }
      perRound = (size() - s0) / 50; } finally { await l.close(); }
    return { pass: errors.length === 0 && unsettled.length === 0 && refusal?.status === 409 && refusal.code === 'SESSION_STORAGE_FULL' && worstCaseRounds > 0,
      completedRounds: rounds, worstCaseRoundsNearLimit: worstCaseRounds, refusal, serverErrors: errors, unsettledRounds: unsettled, localStoreBytesPerRound: perRound,
      stillOpen: 'Once refused, the play session cannot start new voyages; normalised storage (F03 root fix) is deferred.' };
  });

await check('S16', 'defect', 'F05: survivors at the final port stay uncredited until an explicit collect', 'Reported in audit F05.',
  'Force all containers safe, sail to the final stop of each mode, attempt another advance, inspect status and ledger; then collect.', () => perAdapter(async (a, c) => {
    const rows = []; await startSession(c);
    for (const mode of Object.keys(MODES)) {
      if (c.raw().balanceCents < 3000) await act(c, '/api/reset');
      const b = await bet(c, { difficulty: mode }); await forceHazards(c, safeHazards); const id = b.body.round.id;
      for (let s = 0; s < MODES[mode].payouts.length; s++) await act(c, `/api/rounds/${id}/advance`);
      const extra = await act(c, `/api/rounds/${id}/advance`), raw = c.raw(), r = raw.rounds[id];
      rows.push({ mode, status: r.status, extraAdvance: extra.status, credited: raw.ledger.filter(e => e.roundId === id && e.kind === 'collect').length });
      await act(c, `/api/rounds/${id}/collect`, { containerId: 'all' });
    }
    return { ok: rows.every(r => r.status === 'active' && r.extraAdvance === 409 && r.credited === 0), rows };
  }));

await check('S17', 'remediated', 'F07 fixed: a second Store on the same directory cannot overwrite an acknowledged debit', 'Reported in audit F07; fixed in phase 4A (server/lock.js folder lock with fencing).',
  'Open two Store objects on one temp directory; debit 100 cents through the first; attempt an unrelated write through the stale second (must be refused); reload from disk. Process-level coverage is in audit/tests/phase4a.test.js and restart.test.js.', () => {
    const dir = fs.mkdtempSync(fileURLToPath(new URL('./results/', import.meta.url)) + '.store-');
    try {
      const s1 = new Store(dir); s1.transaction(st => { st.sessions.x = createSession('x', derivedSeed('s17', 0)); });
      const s2 = new Store(dir);
      s1.transaction(st => { st.sessions.x.balanceCents -= 100; });
      let refusedCode = null; try { s2.transaction(st => { st.sessions.y = { note: 'unrelated write' }; }); } catch (e) { refusedCode = e.code; }
      const reloaded = new Store(dir).get('x').balanceCents; s1.release();
      return { pass: refusedCode === 'DATA_DIRECTORY_LOCKED' && reloaded === 99900, secondWriterRefusedWith: refusedCode, balanceOnDiskAfterSecondAttempt: reloaded };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

await check('S18', 'remediated', 'F08 fixed: verifyRound() rejects altered metadata and malformed structure', 'Reported in audit F08; fixed in phase 2 (public/fairness.js strict cargo-v1 schema).',
  'Settle a natural (unforced) engine round, then alter proof.algorithm, multiplier100, id format, a container valueCents, nextRisk, maxStops and timestamps, append a duplicate container and add an unknown field; every variant must be rejected while the original verifies.', async () => {
    let s, r;
    for (let k = 0; ; k++) {
      const seed = derivedSeed('s18', k); s = createSession('s18', seed);
      r = beginRound(s, { difficulty: 'easy', stakeCents: 3000, clientSeed: 'p', expectedSeedHash: seedHash(seed) }, derivedSeed('s18-next', k));
      advanceRound(s, r.id); if (r.containers.every(x => x.status === 'onboard')) break;
    }
    collectRound(s, r.id, 'all');
    const base = publicRound(r), variants = {
      algorithm: p => { p.proof.algorithm = 'not-cargo'; }, multiplier100: p => { p.multiplier100 = 999999; }, roundIdFormat: p => { p.id = 'forged-id'; },
      valueCents: p => { p.containers[0].valueCents = 123456789; }, nextRisk: p => { p.nextRisk = 0.99; }, maxStops: p => { p.maxStops = 1; },
      duplicateContainer: p => { p.containers.push(structuredClone(p.containers[0])); }, timestamps: p => { p.startedAt = 'not-a-time'; }, unknownField: p => { p.bonusCents = 1; }
    };
    const accepted = {};
    for (const [k, f] of Object.entries(variants)) { const p = structuredClone(base); f(p); accepted[k] = (await verifyRound(p)).valid; }
    return { pass: (await verifyRound(base)).valid && Object.values(accepted).every(v => v === false), acceptedAfterTampering: accepted,
      remainingLimitation: 'A different but well-formed round ID and plausible timestamps cannot be detected: they are not bound into the seed commitment.' };
  });

await check('S19', 'defect', 'F11: a deployment that changes the payout table alters settlement of an accepted wager', 'Reported in audit F11 (still open). The phase-2 deep freeze (N02) blocks in-process mutation, so a later deployment is modelled instead.',
  'Accept and advance an Easy round with the current engine and persist it as JSON; load an isolated engine copy whose Easy stop-1 multiplier is 1.04×; settle the persisted round with it.', async () => {
    const { loadEngineVariant } = await import('./lib/engine-variant.mjs');
    const seed = derivedSeed('s19', 0), s = createSession('s19', seed);
    const r = beginRound(s, { difficulty: 'easy', stakeCents: 300, clientSeed: 'v', expectedSeedHash: seedHash(seed) }, derivedSeed('s19', 1));
    r.hazards = safeHazards; advanceRound(s, r.id);
    const persisted = JSON.parse(JSON.stringify(s)), next = await loadEngineVariant(t => t.replace('1, [103,109,', '1, [104,109,'));
    next.game.collectRound(persisted, r.id, 'A');
    let inProcessMutationBlocked = false; try { MODES.easy.payouts[0] = 104; } catch { inProcessMutationBlocked = true; }
    const paid = persisted.rounds[r.id].containers[0].payoutCents;
    return { pass: paid === 104 && inProcessMutationBlocked && MODES.easy.payouts[0] === 103, paidCents: paid, expectedUnderAcceptedRules: 103, inProcessMutationBlocked, roundStoresMathVersion: Object.keys(r).filter(k => /version|table|payouts/i.test(k)) };
  });

await check('S20', 'remediated', 'N01 fixed: UTF-8 characters split across request body chunks are decoded intact; invalid UTF-8 is refused', 'A client seed may contain multi-byte characters; TCP may split a body anywhere.',
  'Local: write the bet body in two socket writes 60 ms apart, splitting the 4-byte "🚢"; Worker: same split via a ReadableStream body. Compare the stored clientSeed with the one sent. Then send a body containing an invalid UTF-8 sequence to both adapters (must be 400).', async () => {
    const seedText = 'ship-🚢-cargo', out = {};
    { const a = await localAdapter(); try {
      const c = a.client(), s = await startSession(c);
      const bytes = Buffer.from(JSON.stringify({ difficulty: 'easy', stakeCents: 300, clientSeed: seedText, expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('u8') }));
      const cut = bytes.indexOf(Buffer.from('🚢')) + 2;
      const status = await new Promise((resolve, reject) => {
        const req = http.request(a.url + '/api/rounds', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c.jar.header(), Origin: a.url, 'Content-Length': bytes.length } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject); req.write(bytes.subarray(0, cut)); setTimeout(() => req.end(bytes.subarray(cut)), 60);
      });
      const stored = Object.values(c.raw().rounds)[0]?.clientSeed;
      const invalid = await c.post('/api/reset', null, {}, Buffer.concat([Buffer.from('{"revision":1,"actionId":"bad-utf8-1","x":"'), Buffer.from([0xC3, 0x28]), Buffer.from('"}')]));
      out.local = { status, stored, intact: stored === seedText, invalidUtf8Status: invalid.status };
    } finally { await a.close(); } }
    { const a = await workerAdapter(); try {
      const c = a.client(), s = await startSession(c);
      const bytes = Buffer.from(JSON.stringify({ difficulty: 'easy', stakeCents: 300, clientSeed: seedText, expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('u8w') }));
      const cut = bytes.indexOf(Buffer.from('🚢')) + 2;
      const stream = new ReadableStream({ start(ctrl) { ctrl.enqueue(new Uint8Array(bytes.subarray(0, cut))); ctrl.enqueue(new Uint8Array(bytes.subarray(cut))); ctrl.close(); } });
      const { default: worker } = await import('../server/worker.js');
      const res = await worker.fetch(new Request('https://cargo.test/api/rounds', { method: 'POST', duplex: 'half', body: stream, headers: { 'Content-Type': 'application/json', Cookie: c.jar.header(), Origin: 'https://cargo.test' } }), a.env);
      const stored = Object.values(c.raw().rounds)[0]?.clientSeed;
      const invalid = await c.post('/api/reset', null, {}, Buffer.concat([Buffer.from('{"revision":1,"actionId":"bad-utf8-1","x":"'), Buffer.from([0xC3, 0x28]), Buffer.from('"}')]));
      out.worker = { status: res.status, stored, intact: stored === seedText, invalidUtf8Status: invalid.status };
    } finally { await a.close(); } }
    return { pass: out.local.intact && out.worker.intact && out.local.invalidUtf8Status === 400 && out.worker.invalidUtf8Status === 400, adapters: out };
  });

await check('S21', 'observation', '"Refill" sets the balance to $1,000 even when the balance is higher', 'UI text says "Set your play balance to $1,000.00".',
  'Win a forced round so the balance exceeds $1,000, then POST /api/reset; inspect the ledger entry.', () => perAdapter(async (a, c) => {
    const b = await bet(c); await forceHazards(c, safeHazards); await act(c, `/api/rounds/${b.body.round.id}/advance`); await act(c, `/api/rounds/${b.body.round.id}/collect`, { containerId: 'all' });
    const high = c.raw().balanceCents; await act(c, '/api/reset'); const entry = c.raw().ledger.at(-1);
    const zero = await act(c, '/api/reset'), zeroEntry = c.raw().ledger.at(-1);
    return { ok: true, balanceBefore: high, refillEntryCents: entry.amountCents, balanceAfter: c.raw().balanceCents, refillAtExactly100000Status: zero.status, zeroAmountEntry: zeroEntry.amountCents === 0 };
  }));

const failed = checks.filter(c => !c.pass);
fs.writeFileSync(outFile, JSON.stringify({ meta: { script: 'audit/validate-system.mjs', node: process.version, generatedAt: new Date().toISOString(), runtimeMs: Date.now() - t0 },
  summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.map(c => c.id), byType: Object.fromEntries(['safety', 'remediated', 'mitigated', 'defect', 'observation'].map(t => [t, checks.filter(c => c.type === t).map(c => `${c.id}:${c.pass ? 'pass' : 'FAIL'}`)])) },
  checks }, null, 1));
console.error(`${checks.length - failed.length}/${checks.length} system checks passed → ${outFile}`);
process.exitCode = failed.length ? 1 : 0;
