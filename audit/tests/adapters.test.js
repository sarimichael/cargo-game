// Safety regression tests against BOTH real adapters (local HTTP + hosted Worker).
// Run: node --test audit/tests/*.test.js   (the Worker uses node:sqlite)
import test from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS, aid, startSession, bet, act, ledgerInvariant } from '../lib/harness.mjs';
import { payout, splitStake } from '../../public/math.js';

const safe = { A: [20], B: [20], C: [20] };
const force = (c, h) => c.mutate(s => { s.rounds[s.currentRoundId].hazards = h; });

for (const [kind, make] of Object.entries(ADAPTERS)) {
  test(`${kind}: duplicate and competing requests settle exactly once`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client();
    const s = await startSession(c), body = { difficulty: 'easy', stakeCents: 3001, clientSeed: 't', expectedSeedHash: s.session.nextSeedHash, revision: 0, actionId: aid('d') };
    const bets = await Promise.all(Array.from({ length: 10 }, () => c.post('/api/rounds', body)));
    assert.ok(bets.every(r => r.status === 200)); assert.equal(c.raw().ledger.length, 1);
    await force(c, safe);
    const id = bets[0].body.round.id, rev = bets[0].body.session.revision;
    const race = await Promise.all([c.post(`/api/rounds/${id}/advance`, { revision: rev, actionId: aid('x') }), c.post(`/api/rounds/${id}/advance`, { revision: rev, actionId: aid('y') })]);
    assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
    const st = (await c.get('/api/session')).body, cb = { revision: st.session.revision, actionId: aid('c'), containerId: 'all' };
    await Promise.all(Array.from({ length: 10 }, () => c.post(`/api/rounds/${id}/collect`, cb)));
    const raw = c.raw();
    assert.equal(raw.ledger.filter(e => e.kind === 'collect').length, 3);
    assert.equal(raw.balanceCents, 100000 - 3001 + splitStake(3001).reduce((x, w) => x + payout(w, 103), 0));
    assert.ok(ledgerInvariant(raw).ok);
  });

  test(`${kind}: malformed input never changes stored state`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client();
    const s = await startSession(c), base = { difficulty: 'easy', stakeCents: 3000, clientSeed: 'v', expectedSeedHash: s.session.nextSeedHash, revision: 0 };
    for (const change of [{ stakeCents: 299 }, { stakeCents: 300001 }, { stakeCents: 300.5 }, { stakeCents: '3000' }, { difficulty: '__proto__' }, { difficulty: 'constructor' }, { clientSeed: '' }, { clientSeed: 'a'.repeat(129) }, { expectedSeedHash: 'x' }, { revision: 1.5 }, { actionId: 'bad id!' }]) {
      const before = JSON.stringify(c.raw()), r = await c.post('/api/rounds', { ...base, actionId: aid('m'), ...change });
      assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(change)); assert.equal(JSON.stringify(c.raw()), before, JSON.stringify(change));
    }
  });

  test(`${kind}: active-round responses never reveal the seed; settlement reveals it`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client(); await startSession(c);
    const b = await bet(c, { difficulty: 'expert' }), id = b.body.round.id, seed = c.raw().rounds[id].serverSeed;
    for (const r of [b, await c.get('/api/session'), await c.get('/api/rounds/' + id)]) {
      assert.ok(!JSON.stringify(r.body).includes(seed)); assert.ok(!('hazards' in r.body.round.proof));
    }
    let st = (await c.get('/api/session')).body;
    while (st.round.status === 'active') st = (st.round.step === st.round.maxStops ? await act(c, `/api/rounds/${id}/collect`, { containerId: 'all' }) : await act(c, `/api/rounds/${id}/advance`)).body;
    assert.equal(st.round.proof.serverSeed, seed);
  });

  test(`${kind}: cross-origin, wrong content type, oversized and sessionless requests are refused`, async t => {
    const a = await make(); t.after(() => a.close()); const c = a.client(); const s = await startSession(c), rev = s.session.revision;
    assert.equal((await c.post('/api/reset', { revision: rev, actionId: aid('o') }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await c.post('/api/reset', { revision: rev, actionId: aid('t') }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await c.post('/api/reset', { revision: rev, actionId: aid('b'), pad: 'x'.repeat(17000) })).status, 413);
    assert.equal((await c.fork().post('/api/reset', { revision: 0, actionId: aid('n') })).status, 401);
  });
}
