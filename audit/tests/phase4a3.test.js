// Phase 4A.3 regression tests: the server-side premises of the browser's equal-revision replacement check (M-02).
// public/app.js treats an in-order read whose revision equals the one on screen but whose displayed state differs
// as a different session. That is safe only if, for one session, an action's response and any later read of the
// unchanged session compare equal (otherwise a player would see false "different session" notices and lose a typed
// bet), and if two different sessions at the same revision compare different. Both adapters are checked, using the
// comparison exactly as it appears in public/app.js. The browser behaviour itself is covered by
// audit/browser-phase4a3.mjs. See CARGO_PHASE4A3_CORRECTION_REPORT.md; the coverage rule was made independent of random
// voyage length in Phase 4A.4 (CARGO_PHASE4A4_CORRECTION_REPORT.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ADAPTERS, aid } from '../lib/harness.mjs';

const source = fs.readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
const definition = /const sameState=(\(a,b\)=>[^;\n]+);/.exec(source);
const sameState = new Function('return ' + definition?.[1])();

test('[4A.3] the comparison is taken from public/app.js', () => {
  assert.ok(definition, 'sameState definition found in public/app.js');
  assert.equal(typeof sameState, 'function');
});

for (const kind of Object.keys(ADAPTERS)) {
  test(`[4A.3] ${kind}: action responses, replays and later reads of an unchanged session compare equal`, async () => {
    const adapter = await ADAPTERS[kind](), c = adapter.client();
    try {
      // Coverage follows what actually happened, not a fixed count of states [4A.4]. Voyages are played until every kind
      // of change has been compared at least once: a bet, a sail, a single collection and a collection of all remaining
      // cargo, with at least two settled voyages (Easy, then Expert with an uneven split). A refill, a replay and the
      // first read are always compared. A voyage that settles early from legitimate losses only leads to another voyage;
      // the game's randomness is untouched. Bets and sails happen in every voyage. The two collection kinds need cargo to
      // survive: on Easy (independent decks, loss chance 1/20 then 1/19) a voyage provides both with probability above
      // 0.983, so the 20 Easy voyages allowed below all failing to provide them has probability below 1e-35.
      let shown = (await c.get('/api/session')).body, last, voyages = 0;
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
      const onboard = () => shown.round.containers.filter(x => x.status === 'onboard').map(x => x.id);
      const voyage = async (stakeCents, difficulty) => {
        await step('bet', '/api/rounds', { difficulty, stakeCents, clientSeed: 'p4a3-' + kind, expectedSeedHash: shown.session.nextSeedHash });
        await step('advance', '/api/rounds/' + shown.round.id + '/advance');
        if (shown.round.status === 'active') await step('collect', '/api/rounds/' + shown.round.id + '/collect', { containerId: onboard()[0] });
        if (shown.round.status === 'active') await step('advance', '/api/rounds/' + shown.round.id + '/advance');
        if (shown.round.status === 'active') await step('collectAll', '/api/rounds/' + shown.round.id + '/collect', { containerId: 'all' });
        assert.equal(shown.round.status, 'settled');
      };
      await expectSame('read', shown);
      while (voyages < 2 || !compared.collect || !compared.collectAll) {
        assert.ok(voyages < 40, 'collections not reached in 40 voyages: ' + JSON.stringify(compared));
        await (voyages % 2 ? voyage(301, 'expert') : voyage(3000, 'easy')); voyages++;
      }
      assert.ok(shown.history.length >= 2, 'at least two settled voyages in the history');
      await step('reset', '/api/reset');
      // A retried action is answered with `replayed: true`; it still compares equal to a read.
      const replay = await c.post(last.route, last.body);
      assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
      await expectSame('replay', replay.body);
      for (const [change, n] of Object.entries(compared)) assert.ok(n >= 1, `${change} compared ${n} times`);
    } finally { await adapter.close(); }
  });

  test(`[4A.3] ${kind}: two sessions at the same revision compare different`, async () => {
    const adapter = await ADAPTERS[kind]();
    try {
      const a = adapter.client(), b = adapter.client();
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
