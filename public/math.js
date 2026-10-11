// Versioned payout ladders in integer hundredths, which keep money calculations exact.
// A round settles with the table recorded when its bet was accepted; never edit a published table.
export const PAYTABLES = Object.freeze({
  // round(0.98 / survival, 2). Rounds saved before tables were versioned carry no table ID and use this one.
  'rtp-98': Object.freeze({
    easy: Object.freeze([103,109,115,123,131,140,151,163,178,196,218,245,280,327,392,490,653,980,1960]),
    medium: Object.freeze([115,137,164,200,246,307,391,508,677,931,1330,1995,3192,5586,11172,27930,111720]),
    hard: Object.freeze([131,177,246,348,506,759,1181,1918,3289,6029,12059,27132,72352,253232,1519392]),
    expert: Object.freeze([196,414,931,2261,6029,18088,63308,274335,1646008,18106088])
  }),
  // round(0.968 / survival, 2), half up.
  'rtp-96.8': Object.freeze({
    easy: Object.freeze([102,108,114,121,129,138,149,161,176,194,215,242,277,323,387,484,645,968,1936]),
    medium: Object.freeze([114,135,162,197,243,303,386,502,669,920,1314,1971,3153,5518,11035,27588,110352]),
    hard: Object.freeze([129,175,243,344,500,750,1166,1895,3248,5956,11911,26800,71466,250131,1500787]),
    expert: Object.freeze([194,409,920,2233,5956,17867,62533,270975,1625853,17884381])
  })
});
export const LEGACY_PAYTABLE = 'rtp-98';
export const CONTAINERS = ['A', 'B', 'C'];
export const RULES = { minBetCents: 300, maxBetCents: 300000, startingBalanceCents: 100000, currency: 'USD', algorithm: 'cargo-v1', paytable: 'rtp-96.8' };
// Published ladder for new bets.
export const MODES = Object.freeze({
  easy: { name: 'Easy', color: '#69d9f1', hazards: 1, payouts: PAYTABLES[RULES.paytable].easy },
  medium: { name: 'Medium', color: '#5ce6bb', hazards: 3, payouts: PAYTABLES[RULES.paytable].medium },
  hard: { name: 'Hard', color: '#f0c374', hazards: 5, payouts: PAYTABLES[RULES.paytable].hard },
  expert: { name: 'Expert', color: '#f58396', hazards: 10, payouts: PAYTABLES[RULES.paytable].expert }
});
export function payoutsFor(mode, paytable = RULES.paytable) {
  if (!Object.hasOwn(PAYTABLES, paytable)) throw new Error('Unknown payout table.');
  return PAYTABLES[paytable][mode];
}
export function splitStake(cents) {
  const base = Math.floor(cents / 3), remainder = cents % 3;
  return CONTAINERS.map((_, i) => base + (i < remainder ? 1 : 0));
}
export function payout(stakeCents, multiplier100) {
  const product = stakeCents * multiplier100;
  if (!Number.isSafeInteger(product)) throw new Error('Amount exceeds the exact calculation range.');
  return Math.floor((product + 50) / 100);
}
export function multiplier(mode, step, paytable) { return step === 0 ? 100 : payoutsFor(mode, paytable)[step - 1]; }
export function nextRisk(mode, completedStep) {
  return completedStep >= MODES[mode].payouts.length ? 0 : MODES[mode].hazards / (20 - completedStep);
}
export function randomMessage(clientSeed, nonce, containerId, counter) {
  return JSON.stringify(['cargo-v1', clientSeed, nonce, containerId, counter]);
}
export function formatMoney(cents) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100); }
export function formatMultiplier(hundredths) { return (hundredths / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '×'; }
