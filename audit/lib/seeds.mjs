// Deterministic fixture material. Audit runs must be reproducible, so instead of
// production newSeed() (OS CSPRNG, non-reproducible) we derive 32-byte server
// seeds with SHA-256 over a labelled counter. ASSUMPTION: SHA-256 output is a
// valid stand-in for uniformly random 32-byte seeds when testing the
// seed→hazard-deck mapping. The OS entropy source itself is NOT tested here.
import { createHash } from 'node:crypto';

export const AUDIT_DOMAIN = 'cargo-audit-v1';
export const derivedSeed = (label, index) => createHash('sha256').update(`${AUDIT_DOMAIN}|${label}|${index}`).digest('hex');

// Small deterministic PRNG (SplitMix64 over BigInt, output 32-bit) for choosing
// test actions. It never feeds game outcomes.
export function splitmix(seedText) {
  let state = BigInt('0x' + createHash('sha256').update(seedText).digest('hex').slice(0, 16));
  const mask = (1n << 64n) - 1n;
  const next = () => {
    state = (state + 0x9E3779B97F4A7C15n) & mask;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & mask;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & mask;
    return Number((z ^ (z >> 31n)) >> 32n);
  };
  next.int = n => next() % n; // tiny modulo bias is irrelevant for action selection
  next.pick = arr => arr[next.int(arr.length)];
  return next;
}
