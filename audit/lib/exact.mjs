// Independent exact arithmetic for the Cargo audit.
// Nothing here imports production code: these are reference implementations
// written from docs/FAIRNESS.md so they can be compared against public/math.js.

export const POSITIONS = 20;

export function gcd(a, b) {
  a = a < 0n ? -a : a; b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}

// Immutable exact rational with BigInt numerator/denominator.
export class Fraction {
  constructor(n, d = 1n) {
    n = BigInt(n); d = BigInt(d);
    if (d === 0n) throw new RangeError('zero denominator');
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    this.n = n / g; this.d = d / g;
  }
  static of(x) { return x instanceof Fraction ? x : new Fraction(x); }
  add(o) { o = Fraction.of(o); return new Fraction(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { o = Fraction.of(o); return new Fraction(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { o = Fraction.of(o); return new Fraction(this.n * o.n, this.d * o.d); }
  div(o) { o = Fraction.of(o); return new Fraction(this.n * o.d, this.d * o.n); }
  cmp(o) { o = Fraction.of(o); const l = this.n * o.d, r = o.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
  eq(o) { return this.cmp(o) === 0; }
  // Decimal string truncated toward zero is not wanted: round half up at `digits`.
  toFixed(digits) {
    const scale = 10n ** BigInt(digits), neg = this.n < 0n, n = neg ? -this.n : this.n;
    const scaled = (n * scale * 2n + this.d) / (2n * this.d);
    const int = scaled / scale, frac = (scaled % scale).toString().padStart(digits, '0');
    return (neg && scaled ? '-' : '') + int + (digits ? '.' + frac : '');
  }
  toNumber() { return Number(this.n) / Number(this.d); }
}

export function choose(n, k) {
  n = BigInt(n); k = BigInt(k);
  if (k < 0n || k > n) return 0n;
  let r = 1n;
  for (let i = 0n; i < k; i++) r = r * (n - i) / (i + 1n);
  return r;
}

// Documented hazard counts and stop counts (docs/FAIRNESS.md, README.md).
export const DOCUMENTED = {
  easy: { hazards: 1, stops: 19 },
  medium: { hazards: 3, stops: 17 },
  hard: { hazards: 5, stops: 15 },
  expert: { hazards: 10, stops: 10 }
};

// Cumulative survival through stop s for one container with h hazards.
export const survivalCount = (h, s) => choose(POSITIONS - s, h);
export const survival = (h, s) => new Fraction(survivalCount(h, s), choose(POSITIONS, h));
// Conditional loss when attempting stop s after surviving 1..s-1.
export const conditionalLoss = (h, s) => new Fraction(h, POSITIONS + 1 - s);

// round-half-up(98 / S) in integer hundredths, exactly.
export function nominalMultiplier100(h, s, rtpPercent = 98n) {
  const S = survival(h, s), num = rtpPercent * S.d, den = S.n; // value = num/den hundredths
  return { value: (2n * num + den) / (2n * den), isTie: (2n * num) % (2n * den) === den, exact: new Fraction(num, den) };
}

// Reference stake split: remainder cents go to A, then B.
export function referenceSplit(totalCents) {
  const W = BigInt(totalCents), base = W / 3n, r = W % 3n;
  return [base + (r >= 1n ? 1n : 0n), base + (r === 2n ? 1n : 0n), base];
}

// Reference payout: nearest cent, half up, once per container.
export const referencePayout = (stakeCents, multiplier100) => (BigInt(stakeCents) * BigInt(multiplier100) + 50n) / 100n;

// Enumerate every h-subset of {1..20}; callback receives the sorted subset.
export function forEachSubset(h, fn) {
  const idx = Array.from({ length: h }, (_, i) => i + 1);
  for (;;) {
    fn(idx);
    let i = h - 1;
    while (i >= 0 && idx[i] === POSITIONS - (h - 1 - i)) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < h; j++) idx[j] = idx[j - 1] + 1;
  }
}

export const pct = (f, digits = 6) => f.mul(100).toFixed(digits) + '%';
