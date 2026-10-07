// Minimal statistics for diagnostic RNG screens. Not a certification battery.

// Lanczos log-gamma (g=7, n=9), accurate to ~1e-15 for x > 0.
const L = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
export function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = L[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += L[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Regularized upper incomplete gamma Q(a, x) (Numerical Recipes gser/gcf).
export function gammaQ(a, x) {
  if (x < 0 || a <= 0) throw new RangeError('bad gammaQ args');
  if (x === 0) return 1;
  const gln = logGamma(a);
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 10000; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

// Upper-tail p-value of a chi-square statistic with `df` degrees of freedom.
export const chiSquareP = (stat, df) => gammaQ(df / 2, stat / 2);

// Goodness of fit: observed counts vs expected probabilities.
export function chiSquareGOF(observed, probabilities) {
  const total = observed.reduce((a, b) => a + b, 0);
  let stat = 0, minExpected = Infinity;
  observed.forEach((o, i) => { const e = total * probabilities[i]; minExpected = Math.min(minExpected, e); stat += (o - e) ** 2 / e; });
  const df = observed.length - 1;
  return { stat, df, p: chiSquareP(stat, df), minExpected, total };
}

// Independence test for an r×c contingency table (rows/cols with zero margins dropped).
export function chiSquareIndependence(table) {
  const rows = table.map(r => r.reduce((a, b) => a + b, 0));
  const cols = table[0].map((_, j) => table.reduce((a, r) => a + r[j], 0));
  const total = rows.reduce((a, b) => a + b, 0);
  const ri = rows.map((v, i) => v > 0 ? i : -1).filter(i => i >= 0), cj = cols.map((v, j) => v > 0 ? j : -1).filter(j => j >= 0);
  let stat = 0, minExpected = Infinity;
  for (const i of ri) for (const j of cj) {
    const e = rows[i] * cols[j] / total; minExpected = Math.min(minExpected, e);
    stat += (table[i][j] - e) ** 2 / e;
  }
  const df = (ri.length - 1) * (cj.length - 1);
  return { stat, df, p: chiSquareP(stat, df), minExpected, total };
}

export function pearson(xs, ys) {
  const n = xs.length; let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n; let cxy = 0, cxx = 0, cyy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; cxy += dx * dy; cxx += dx * dx; cyy += dy * dy; }
  const r = cxy / Math.sqrt(cxx * cyy);
  return { r, z: r * Math.sqrt(n), n };
}

// Wilson score interval for a binomial proportion at 95%.
export function wilson(successes, n, z = 1.959963984540054) {
  const p = successes / n, z2 = z * z, den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den, half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
  return [centre - half, centre + half];
}
