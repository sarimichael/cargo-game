// Published payout ladder ('ladder-v1'). Integer hundredths keep money calculations exact.
// These literal multipliers are immutable; a different ladder must be added as a new table ID.
const mode = (name, color, hazards, payouts) => Object.freeze({ name, color, hazards, payouts: Object.freeze(payouts) });
export const MODES = Object.freeze({
  easy: mode('Easy', '#69d9f1', 1, [103,109,115,123,131,140,151,163,178,196,218,245,280,327,392,490,653,980,1960]),
  medium: mode('Medium', '#5ce6bb', 3, [115,137,164,200,246,307,391,508,677,931,1330,1995,3192,5586,11172,27930,111720]),
  hard: mode('Hard', '#f0c374', 5, [131,177,246,348,506,759,1181,1918,3289,6029,12059,27132,72352,253232,1519392]),
  expert: mode('Expert', '#f58396', 10, [196,414,931,2261,6029,18088,63308,274335,1646008,18106088])
});
export const PAYTABLES = Object.freeze({ 'ladder-v1': Object.freeze(Object.fromEntries(Object.entries(MODES).map(([id, m]) => [id, m.payouts]))) });
// Randomness and odds versions. Every round stores the version it was accepted under and keeps it until settlement.
//  cargo-v1: fixed-count hazard deck per container (legacy; nominal 98% before rounding; stake-independent odds).
//  cargo-v2: calibrated per-stop survival; exactly 96.8% expected return for every collection strategy.
export const ALGORITHMS = Object.freeze(['cargo-v1', 'cargo-v2']);
// Rounds saved before rules were pinned carry algorithm 'cargo-v1' and no paytable.
export const LEGACY_PAYTABLE = 'ladder-v1';
// cargo-v2 target return: 121/125 = 96.8% of every container stake.
export const RTP_NUMERATOR = 121, RTP_DENOMINATOR = 125;
export const CONTAINERS = ['A', 'B', 'C'];
export const RULES = { minBetCents: 300, maxBetCents: 300000, startingBalanceCents: 100000, currency: 'USD', algorithm: 'cargo-v2', paytable: 'ladder-v1' };
export function splitStake(cents) {
  const base = Math.floor(cents / 3), remainder = cents % 3;
  return CONTAINERS.map((_, i) => base + (i < remainder ? 1 : 0));
}
export function payout(stakeCents, multiplier100) {
  const product = stakeCents * multiplier100;
  if (!Number.isSafeInteger(product)) throw new Error('Amount exceeds the exact calculation range.');
  return Math.floor((product + 50) / 100);
}
export function payoutsFor(mode, paytable = RULES.paytable) {
  if (!Object.hasOwn(PAYTABLES, paytable) || !Object.hasOwn(MODES, mode)) throw new Error('Unknown payout table.');
  return PAYTABLES[paytable][mode];
}
export function multiplier(mode, step, paytable) { return step === 0 ? 100 : payoutsFor(mode, paytable)[step - 1]; }
// Exact probability [numerator, denominator] that a container still on board survives stop `step`.
// cargo-v2: survival to stop 1 is 121w / (125 G1); from stop s-1 to s it is G(s-1) / G(s), where G(s) is the
// integer-cent payout for container stake w at stop s. The product telescopes to 0.968w / G(s), so collecting
// at any stop is worth exactly 0.968w in expectation.
export function survivalOdds(algorithm, mode, stakeCents, step, paytable = LEGACY_PAYTABLE) {
  const ladder = payoutsFor(mode, paytable);
  if (!Number.isInteger(step) || step < 1 || step > ladder.length) throw new Error('Stop is outside this route.');
  if (algorithm === 'cargo-v1') { const h = MODES[mode].hazards; return [21 - step - h, 21 - step]; }
  if (algorithm === 'cargo-v2') {
    const G = s => payout(stakeCents, ladder[s - 1]);
    return step === 1 ? [RTP_NUMERATOR * stakeCents, RTP_DENOMINATOR * G(1)] : [G(step - 1), G(step)];
  }
  throw new Error('Unknown randomness algorithm.');
}
// Loss chance at the stop after `completedStep`, as a number for display. 0 once the final port is reached.
export function lossChance(algorithm, mode, stakeCents, completedStep, paytable) {
  if (completedStep >= payoutsFor(mode, paytable).length) return 0;
  const [survive, outOf] = survivalOdds(algorithm, mode, stakeCents, completedStep + 1, paytable);
  return (outOf - survive) / outOf;
}
export function randomMessage(clientSeed, nonce, containerId, counter) {
  return JSON.stringify(['cargo-v1', clientSeed, nonce, containerId, counter]);
}
export function routeMessage(clientSeed, nonce, containerId, step, attempt) {
  return JSON.stringify(['cargo-v2', clientSeed, nonce, containerId, step, attempt]);
}
export function formatMoney(cents) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100); }
export function formatMultiplier(hundredths) { return (hundredths / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '×'; }
export function formatRisk(chance) { return (chance * 100).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + '%'; }
