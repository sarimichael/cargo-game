// Phase 4A.3 regression tests: the server-side premises of the browser's equal-revision replacement check (M-02).
// public/app.js treats an in-order read whose revision equals the one on screen but whose displayed state differs
// as a different session. That is safe only if, for one session, an action's response and any later read of the
// unchanged session compare equal (otherwise a player would see false "different session" notices and lose a typed
// bet), and if two different sessions at the same revision compare different. Both adapters are checked, using the
// comparison exactly as it appears in public/app.js. The browser behaviour itself is covered by
// audit/browser-phase4a3.mjs. See CARGO_PHASE4A3_CORRECTION_REPORT.md. In Phase 4A.4 the voyages were made
// deterministic with seed fixtures (CARGO_PHASE4A4_CORRECTION_REPORT.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ADAPTERS, aid } from '../lib/harness.mjs';
import { derivedSeed } from '../lib/seeds.mjs';
import { hazardDeck, seedHash } from '../../server/fairness.js';
import { MODES } from '../../public/math.js';
import { verifyRound } from '../../public/fairness.js';

const source = fs.readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
const definition = /const sameState=(\(a,b\)=>[^;\n]+);/.exec(source);
const sameState = new Function('return ' + definition?.[1])();

test('[4A.3] the comparison is taken from public/app.js', () => {
  assert.ok(definition, 'sameState definition found in public/app.js');
  assert.equal(typeof sameState, 'function');
});

// Deterministic voyages [4A.4]. Before each bet, a derived server seed (lib/seeds.mjs) is written into the session's stored
// `nextSeed`: a test-only fixture write, like the forced hazards in other audit tests. The bet consumes it through the
// production beginRound() and hazardDeck(), so every outcome below is fixed while the RNG, its probabilities and the
// rules are untouched; each settled proof is checked with the independent verifier.
const CLIENT_SEED = 'p4a3-coverage';
const EASY = { mode: 'easy', stakeCents: 3000, nonce: 0, seed: derivedSeed('phase4a3-coverage-easy', 3) };
const EXPERT = { mode: 'expert', stakeCents: 301, nonce: 1, seed: derivedSeed('phase4a3-coverage-expert', 0) };
const decks = v => Object.fromEntries(['A', 'B', 'C'].map(id => [id, hazardDeck(v.seed, CLIENT_SEED, v.nonce, id, MODES[v.mode].hazards)]));

test('[4A.4] the voyage fixtures give the required outcomes through the production hazard decks', () => {
  // Easy: nothing is lost at stop 1; B is lost at stop 2 while C survives it.
  assert.deepEqual(decks(EASY), { A: [11], B: [2], C: [8] });
  // Expert: all three containers are lost at stop 1.
  for (const deck of Object.values(decks(EXPERT))) assert.ok(deck.includes(1), JSON.stringify(deck));
});

for (const kind of Object.keys(ADAPTERS)) {
  test(`[4A.3] ${kind}: action responses, replays and later reads of an unchanged session compare equal`, async () => {
    const adapter = await ADAPTERS[kind](), c = adapter.client();
    try {
      // Every step and outcome is fixed by the fixtures above, so the comparisons below are exactly the same in every run.
      let shown = (await c.get('/api/session')).body, last;
      const compared = { read: 0, bet: 0, advance: 0, collect: 0, collectAll: 0, reset: 0, replay: 0 };
      const expectSame = async (kind, response) => {
        const read1 = (await c.get('/api/session')).body, read2 = (await c.get('/api/session')).body;
        assert.equal(read1.session.revision, response.session.revision);
        assert.ok(sameState(read1, response), 'a read after the action shows exactly what the action returned');
        assert.ok(sameState(read2, read1), 'repeated reads of an unchanged session are identical');
        compared[kind]++;
      };
      const step = async (kind, route, extra = {}) => {
        last = { route, body: { revision: shown.session.revision, actionId: aid('p4a3'), ...extra } };
        const r = await c.post(route, last.body);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.session.revision, shown.session.revision + 1, 'every successful action increases the revision by one');
        shown = r.body; await expectSame(kind, shown);
      };
      // The fixture write changes the stored session outside any action, so the page state is read again afterwards.
      const voyage = async v => {
        await c.mutate(s => { s.nextSeed = v.seed; });
        shown = (await c.get('/api/session')).body; assert.equal(shown.session.nextSeedHash, seedHash(v.seed)); await expectSame('read', shown);
        await step('bet', '/api/rounds', { difficulty: v.mode, stakeCents: v.stakeCents, clientSeed: CLIENT_SEED, expectedSeedHash: shown.session.nextSeedHash });
        assert.equal(shown.round.proof.nonce, v.nonce);
      };
      const advance = () => step('advance', '/api/rounds/' + shown.round.id + '/advance');
      const collect = (kind, containerId) => step(kind, '/api/rounds/' + shown.round.id + '/collect', { containerId });
      const containers = () => shown.round.containers.map(x => x.status + (x.collectedAt ? '@' + x.collectedAt : x.lostAt ? '@' + x.lostAt : '')).join(' ');
      await expectSame('read', shown);
      // Voyage 1, Easy, $30.00: sail, collect A, sail (B lost, C survives), collect the rest.
      await voyage(EASY);
      await advance(); assert.equal(containers(), 'onboard onboard onboard');
      await collect('collect', 'A'); assert.equal(containers(), 'collected@1 onboard onboard');
      await advance(); assert.equal(containers(), 'collected@1 lost@2 onboard');
      await collect('collectAll', 'all'); assert.equal(containers(), 'collected@1 lost@2 collected@2'); assert.equal(shown.round.status, 'settled');
      assert.equal((await verifyRound(shown.round)).valid, true, 'the settled proof verifies against the fixture seed');
      // Voyage 2, Expert, $3.01 (uneven split): all three lost at stop 1, so the voyage settles at once.
      await voyage(EXPERT); assert.deepEqual(shown.round.containers.map(x => x.stakeCents), [101, 100, 100]);
      await advance(); assert.equal(containers(), 'lost@1 lost@1 lost@1'); assert.equal(shown.round.status, 'settled'); assert.equal(shown.round.returnedCents, 0);
      assert.equal((await verifyRound(shown.round)).valid, true, 'the settled proof verifies against the fixture seed');
      assert.equal(shown.history.length, 2, 'two settled voyages in the history');
      await step('reset', '/api/reset');
      // A retried action is answered with `replayed: true`; it still compares equal to a read.
      const replay = await c.post(last.route, last.body);
      assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
      await expectSame('replay', replay.body);
      assert.deepEqual(compared, { read: 3, bet: 2, advance: 3, collect: 1, collectAll: 1, reset: 1, replay: 1 });
    } finally { await adapter.close(); }
  });

  test(`[4A.3] ${kind}: two sessions at the same revision compare different`, async () => {
    const adapter = await ADAPTERS[kind]();
    try {
      const a = adapter.client(), b = adapter.client();
      await a.get('/api/session'); await b.get('/api/session');
      // Distinct derived seeds [4A.4]: the sessions differ by construction, not by chance.
      await a.mutate(s => { s.nextSeed = derivedSeed('phase4a3-pair', 0); }); await b.mutate(s => { s.nextSeed = derivedSeed('phase4a3-pair', 1); });
      const fresh = [(await a.get('/api/session')).body, (await b.get('/api/session')).body];
      assert.equal(fresh[0].session.revision, fresh[1].session.revision);
      assert.ok(!sameState(fresh[0], fresh[1]), 'two new sessions at revision 0');
      const bets = [];
      for (const [c, s, stakeCents] of [[a, fresh[0], 3000], [b, fresh[1], 300]]) {
        const r = await c.post('/api/rounds', { revision: s.session.revision, actionId: aid('p4a3'), difficulty: 'easy', stakeCents, clientSeed: 'same-seed', expectedSeedHash: s.session.nextSeedHash });
        assert.equal(r.status, 200); bets.push(r.body);
      }
      assert.equal(bets[0].session.revision, 1); assert.equal(bets[1].session.revision, 1);
      assert.ok(!sameState(bets[0], bets[1]), 'two sessions at revision 1');
    } finally { await adapter.close(); }
  });
}
