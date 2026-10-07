// Independent re-implementation of the documented Cargo v1 hazard-deck algorithm
// (docs/FAIRNESS.md "Independent hazard decks"). Written without importing
// server/fairness.js so agreement is evidence, not tautology.
import { createHmac, createHash } from 'node:crypto';

export const TWO_32 = 2 ** 32;

// Exactly the documented message: JSON array, no spaces, UTF-8.
export const message = (clientSeed, nonce, containerId, counter) =>
  Buffer.from(JSON.stringify(['cargo-v1', clientSeed, nonce, containerId, counter]), 'utf8');

// Default draw source: HMAC-SHA-256(key = raw seed bytes), first 4 bytes big-endian.
export function hmacDrawSource(serverSeedHex, clientSeed, nonce, containerId) {
  const key = Buffer.from(serverSeedHex, 'hex');
  let counter = 0;
  const source = () => {
    const digest = createHmac('sha256', key).update(message(clientSeed, nonce, containerId, counter)).digest();
    counter += 1;
    return ((digest[0] << 24) >>> 0) + (digest[1] << 16) + (digest[2] << 8) + digest[3];
  };
  source.used = () => counter;
  return source;
}

// Unbiased integer in [0, bound) by rejection; `draw` returns uint32.
export function uniformBelow(bound, draw, stats) {
  const limit = Math.floor(TWO_32 / bound) * bound;
  for (;;) {
    const v = draw();
    if (v < limit) return v % bound;
    if (stats) stats.rejections = (stats.rejections || 0) + 1;
  }
}

// Fisher–Yates descending from index 19 to 1, then first h sorted.
export function referenceShuffle(draw, stats) {
  const deck = [];
  for (let p = 1; p <= 20; p++) deck.push(p);
  for (let i = 19; i >= 1; i--) {
    const j = uniformBelow(i + 1, draw, stats);
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return deck;
}

export function referenceHazardDeck(serverSeedHex, clientSeed, nonce, containerId, hazards, stats) {
  const draw = hmacDrawSource(serverSeedHex, clientSeed, nonce, containerId);
  const shuffled = referenceShuffle(draw, stats);
  if (stats) stats.draws = draw.used();
  return shuffled.slice(0, hazards).sort((a, b) => a - b);
}

export const referenceSeedHash = seedHex => createHash('sha256').update(Buffer.from(seedHex, 'hex')).digest('hex');
