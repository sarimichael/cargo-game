import { randomUUID } from 'node:crypto';
import { MODES, RULES, CONTAINERS, LEGACY_PAYTABLE, splitStake, multiplier, payout, nextRisk } from '../public/math.js';
import { hazardDeck, newSeed, seedHash } from './fairness.js';

export class GameError extends Error {
  constructor(message, status = 400, code = 'INVALID_ACTION') { super(message); this.status = status; this.code = code; }
}
const requireThat = (condition, message, status = 400, code) => { if (!condition) throw new GameError(message, status, code); };
export function createSession(id, seed = newSeed()) {
  return { id, balanceCents: RULES.startingBalanceCents, revision: 0, nonce: 0, clientSeed: randomUUID(), nextSeed: seed, currentRoundId: null, rounds: {}, ledger: [], receipts: {} };
}
function entry(session, id, kind, amountCents, roundId) {
  requireThat(!session.ledger.some(x => x.id === id), 'Transaction already exists.', 409);
  const balance = session.balanceCents + amountCents;
  requireThat(Number.isSafeInteger(balance) && balance >= 0, 'Balance cannot support this transaction.', 409);
  session.balanceCents = balance;
  session.ledger.push({ id, kind, amountCents, balanceCents: balance, roundId, at: new Date().toISOString() });
}
// Rounds saved before payout tables were versioned settle with the original table.
const paytableOf = round => round.paytable ?? LEGACY_PAYTABLE;
export function currentRound(session) { return session.currentRoundId ? session.rounds[session.currentRoundId] : null; }
function activeRound(session, id) {
  const round = session.rounds[id];
  requireThat(round && session.currentRoundId === id, 'Voyage not found.', 404);
  requireThat(round.status === 'active', 'This voyage is already settled.', 409, 'ROUND_SETTLED');
  return round;
}
function finish(round) {
  if (round.containers.every(c => c.status !== 'onboard')) {
    round.status = 'settled'; round.finishedAt = new Date().toISOString();
  }
}
export function beginRound(session, body, freshSeed = newSeed()) {
  requireThat(currentRound(session)?.status !== 'active', 'Finish your current voyage first.', 409);
  const { difficulty, stakeCents, clientSeed, expectedSeedHash } = body;
  requireThat(Object.hasOwn(MODES, difficulty), 'Choose a valid difficulty.');
  requireThat(Number.isSafeInteger(stakeCents) && stakeCents >= RULES.minBetCents && stakeCents <= RULES.maxBetCents, 'Bet must be between $3.00 and $3,000.00.');
  requireThat(stakeCents <= session.balanceCents, 'Not enough play money.', 409, 'INSUFFICIENT_BALANCE');
  requireThat(typeof clientSeed === 'string' && clientSeed.length >= 1 && clientSeed.length <= 128, 'Client seed must contain 1–128 characters.');
  requireThat(expectedSeedHash === seedHash(session.nextSeed), 'The seed commitment changed. Refresh and try again.', 409, 'STALE_SEED');
  const id = randomUUID(), stakes = splitStake(stakeCents), serverSeed = session.nextSeed, nonce = session.nonce++;
  const round = { id, difficulty, stakeCents, step: 0, status: 'active', startedAt: new Date().toISOString(), finishedAt: null,
    serverSeed, serverSeedHash: seedHash(serverSeed), clientSeed, nonce, algorithm: 'cargo-v1', paytable: RULES.paytable,
    containers: CONTAINERS.map((containerId, i) => ({ id: containerId, stakeCents: stakes[i], status: 'onboard', payoutCents: 0, collectedAt: null, lostAt: null })),
    hazards: Object.fromEntries(CONTAINERS.map(c => [c, hazardDeck(serverSeed, clientSeed, nonce, c, MODES[difficulty].hazards)])),
    events: [{ kind: 'bet', stakeCents, at: new Date().toISOString() }] };
  entry(session, id + ':bet', 'bet', -stakeCents, id);
  session.rounds[id] = round; session.currentRoundId = id; session.clientSeed = clientSeed; session.nextSeed = freshSeed;
  return round;
}
export function advanceRound(session, id) {
  const round = activeRound(session, id);
  requireThat(round.step < MODES[round.difficulty].payouts.length, 'Final port reached. Collect your remaining cargo.', 409);
  round.step++;
  const lost = [], survived = [];
  for (const c of round.containers) if (c.status === 'onboard') {
    if (round.hazards[c.id].includes(round.step)) { c.status = 'lost'; c.lostAt = round.step; lost.push(c.id); }
    else survived.push(c.id);
  }
  round.events.push({ kind: 'sail', step: round.step, lost, survived, at: new Date().toISOString() });
  finish(round); return round;
}
export function collectRound(session, id, containerId) {
  const round = activeRound(session, id);
  requireThat(round.step >= 1, 'Sail to the first stop before collecting.', 409);
  requireThat(CONTAINERS.includes(containerId) || containerId === 'all', 'Choose a valid container.');
  const selected = round.containers.filter(c => (containerId === 'all' || c.id === containerId) && c.status === 'onboard');
  requireThat(selected.length > 0, 'This cargo has already been collected or lost.', 409);
  const credits = {};
  for (const c of selected) {
    c.payoutCents = payout(c.stakeCents, multiplier(round.difficulty, round.step, paytableOf(round)));
    c.status = 'collected'; c.collectedAt = round.step; credits[c.id] = c.payoutCents;
    entry(session, id + ':collect:' + c.id, 'collect', c.payoutCents, id);
  }
  round.events.push({ kind: 'collect', step: round.step, credits, at: new Date().toISOString() });
  finish(round); return round;
}
export function resetWallet(session) {
  requireThat(currentRound(session)?.status !== 'active', 'Finish your current voyage before refilling.', 409);
  entry(session, randomUUID(), 'refill', RULES.startingBalanceCents - session.balanceCents, null);
}
export function publicRound(round) {
  if (!round) return null;
  const returnedCents = round.containers.reduce((n, c) => n + c.payoutCents, 0), m = multiplier(round.difficulty, round.step, paytableOf(round));
  const result = { id: round.id, difficulty: round.difficulty, stakeCents: round.stakeCents, step: round.step, status: round.status,
    startedAt: round.startedAt, finishedAt: round.finishedAt, multiplier100: m, nextRisk: nextRisk(round.difficulty, round.step),
    maxStops: MODES[round.difficulty].payouts.length, returnedCents, netCents: returnedCents - round.stakeCents,
    containers: round.containers.map(c => ({ ...c, valueCents: c.status === 'onboard' ? payout(c.stakeCents, m) : c.payoutCents })),
    proof: { algorithm: round.algorithm, paytable: paytableOf(round), serverSeedHash: round.serverSeedHash, clientSeed: round.clientSeed, nonce: round.nonce }, events: structuredClone(round.events) };
  if (round.status === 'settled') { result.proof.serverSeed = round.serverSeed; result.proof.hazards = structuredClone(round.hazards); }
  return result;
}
export function snapshot(session) {
  return { config: { modes: MODES, rules: RULES }, session: { balanceCents: session.balanceCents, revision: session.revision,
    clientSeed: session.clientSeed, nonce: session.nonce, nextSeedHash: seedHash(session.nextSeed) },
    round: publicRound(currentRound(session)),
    history: Object.values(session.rounds).filter(r => r.status === 'settled').slice(-20).reverse().map(r => {
      const p = publicRound(r); return { id: p.id, difficulty: p.difficulty, step: p.step, stakeCents: p.stakeCents, returnedCents: p.returnedCents, netCents: p.netCents, finishedAt: p.finishedAt };
    }) };
}
