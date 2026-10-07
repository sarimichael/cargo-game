// Published payout ladder. Integer hundredths keep money calculations exact.
export const MODES = Object.freeze({
  easy: { name: 'Easy', color: '#69d9f1', hazards: 1, payouts: [103,109,115,123,131,140,151,163,178,196,218,245,280,327,392,490,653,980,1960] },
  medium: { name: 'Medium', color: '#5ce6bb', hazards: 3, payouts: [115,137,164,200,246,307,391,508,677,931,1330,1995,3192,5586,11172,27930,111720] },
  hard: { name: 'Hard', color: '#f0c374', hazards: 5, payouts: [131,177,246,348,506,759,1181,1918,3289,6029,12059,27132,72352,253232,1519392] },
  expert: { name: 'Expert', color: '#f58396', hazards: 10, payouts: [196,414,931,2261,6029,18088,63308,274335,1646008,18106088] }
});
export const CONTAINERS = ['A', 'B', 'C'];
export const RULES = { minBetCents: 300, maxBetCents: 300000, startingBalanceCents: 100000, currency: 'USD', algorithm: 'cargo-v1' };
export function splitStake(cents) {
  const base = Math.floor(cents / 3), remainder = cents % 3;
  return CONTAINERS.map((_, i) => base + (i < remainder ? 1 : 0));
}
export function payout(stakeCents, multiplier100) {
  const product = stakeCents * multiplier100;
  if (!Number.isSafeInteger(product)) throw new Error('Amount exceeds the exact calculation range.');
  return Math.floor((product + 50) / 100);
}
export function multiplier(mode, step) { return step === 0 ? 100 : MODES[mode].payouts[step - 1]; }
export function nextRisk(mode, completedStep) {
  return completedStep >= MODES[mode].payouts.length ? 0 : MODES[mode].hazards / (20 - completedStep);
}
export function randomMessage(clientSeed, nonce, containerId, counter) {
  return JSON.stringify(['cargo-v1', clientSeed, nonce, containerId, counter]);
}
export function formatMoney(cents) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100); }
export function formatMultiplier(hundredths) { return (hundredths / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '×'; }
