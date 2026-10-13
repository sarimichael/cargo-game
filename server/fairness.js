import { createHash, createHmac, randomBytes } from 'node:crypto';
import { MODES, randomMessage, routeMessage, survivalOdds } from '../public/math.js';

export const newSeed = () => randomBytes(32).toString('hex');
export const seedHash = seed => createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex');
// cargo-v1 (legacy): a fixed number of hazard stops chosen by a Fisher–Yates shuffle of 1..20.
export function hazardDeck(serverSeed, clientSeed, nonce, containerId, hazards) {
  let counter = 0;
  function randomInt(bound) {
    const limit = Math.floor(0x100000000 / bound) * bound;
    // Reject the incomplete interval instead of introducing modulo bias.
    for (;;) {
      const value = createHmac('sha256', Buffer.from(serverSeed, 'hex'))
        .update(randomMessage(clientSeed, nonce, containerId, counter++)).digest().readUInt32BE(0);
      if (value < limit) return value % bound;
    }
  }
  const positions = Array.from({ length: 20 }, (_, i) => i + 1);
  for (let i = 19; i > 0; i--) {
    const j = randomInt(i + 1);
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  return positions.slice(0, hazards).sort((a, b) => a - b);
}
const TWO_64 = 1n << 64n;
// Uniform integer in [0, bound) from 64-bit draws, rejecting the incomplete top interval (no modulo bias).
export function uniformBelow(bound, draw) {
  const b = BigInt(bound), limit = TWO_64 - TWO_64 % b;
  for (let attempt = 0; ; attempt++) {
    const value = draw(attempt);
    if (value < limit) return value % b;
  }
}
// cargo-v2: each stop is an independent exact Bernoulli trial with the container's own rational survival odds.
// Returns [] when the container survives every stop, otherwise [the stop where it is lost].
export function calibratedRoute(serverSeed, clientSeed, nonce, containerId, mode, stakeCents, paytable) {
  const key = Buffer.from(serverSeed, 'hex');
  for (let step = 1; step <= MODES[mode].payouts.length; step++) {
    const [survive, outOf] = survivalOdds('cargo-v2', mode, stakeCents, step, paytable);
    const draw = attempt => createHmac('sha256', key).update(routeMessage(clientSeed, nonce, containerId, step, attempt)).digest().readBigUInt64BE(0);
    if (uniformBelow(outOf, draw) >= BigInt(survive)) return [step];
  }
  return [];
}
