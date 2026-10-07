import { createHash, createHmac, randomBytes } from 'node:crypto';
import { randomMessage } from '../public/math.js';

export const newSeed = () => randomBytes(32).toString('hex');
export const seedHash = seed => createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex');
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
