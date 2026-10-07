// Cross-checks the numeric claims printed in CARGO_SAYCOVE_AUDIT.md.
//
// Usage: node audit/validate-claims.mjs [--out audit/results/claims.json]
// Requires audit/results/math.json (run validate-math.mjs first).
//
// Three kinds of claim are distinguished:
//   REPRODUCED   – recomputed exactly from source and matched to the printed precision
//   CONSISTENT   – an unreproducible measurement (the original random sample was not
//                  retained) whose printed figures agree with each other arithmetically
//   UNVERIFIABLE – depends on evidence that is not available (deleted scripts, live site)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODES, payout, splitStake } from '../public/math.js';
import { Fraction, survival, choose, pct } from './lib/exact.mjs';
import { wilson } from './lib/stats.mjs';

const arg = (n, f) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : f; };
const outFile = arg('out', fileURLToPath(new URL('./results/claims.json', import.meta.url)));
const auditPath = fileURLToPath(new URL('../CARGO_SAYCOVE_AUDIT.md', import.meta.url));
const text = fs.readFileSync(auditPath, 'utf8');
const math = JSON.parse(fs.readFileSync(new URL('./results/math.json', import.meta.url), 'utf8'));
const M = id => math.checks.find(c => c.id === id);
const modeName = { Easy: 'easy', Medium: 'medium', Hard: 'hard', Expert: 'expert' };

// --- Markdown table extraction keyed by the nearest preceding "###"/"##" heading.
const tables = {};
{
  let heading = null, current = null;
  for (const line of text.split('\n')) {
    const h = /^#{2,3} (.+)$/.exec(line);
    if (h) { heading = h[1].trim(); current = null; continue; }
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (cells.every(c => /^-+$/.test(c))) continue;
      if (!current) { current = { header: cells, rows: [] }; (tables[heading] ??= []).push(current); }
      else current.rows.push(cells);
    } else if (line.trim() !== '') current = null;
  }
}
const num = s => Number(String(s).replace(/[$,×%\s]/g, ''));
const results = [];
function claim(section, kind, description, expected, printed, ok, detail) {
  results.push({ section, kind, description, printed, expected, status: ok ? (kind === 'CONSISTENT' ? 'CONSISTENT' : 'MATCH') : 'MISMATCH', ...(detail ? { detail } : {}) });
}
const money = cents => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mult = h => (h / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '×';

// --- §4 odds and payout tables (REPRODUCED).
const perStop = M('M07').table;
for (const [Name, key] of Object.entries(modeName)) {
  const odds = tables[`${Name} — odds`]?.[0], pays = tables[`${Name} — payouts and returns`]?.[0];
  for (const row of odds?.rows ?? []) {
    const r = perStop[key][Number(row[0]) - 1];
    const exp = [r.condSurvival, r.condLoss, r.cumSurvival, r.cumLoss];
    claim('§4', 'REPRODUCED', `${Name} odds stop ${row[0]}`, exp.join(' | '), row.slice(1).join(' | '), exp.every((v, i) => v === row[i + 1]));
  }
  for (const row of pays?.rows ?? []) {
    const r = perStop[key][Number(row[0]) - 1];
    const nominal = survival(MODES[key].hazards, r.stop).mul(new Fraction(r.multiplier100, 100));
    const exp = [mult(r.multiplier100), nominal.toFixed(8), pct(nominal), pct(new Fraction(1).sub(nominal)), `${r.centRTPMin}–${r.centRTPMax}`, money(r.maxGrossAtMaxBetCents)];
    claim('§4', 'REPRODUCED', `${Name} payouts stop ${row[0]}`, exp.join(' | '), row.slice(1).join(' | '), exp.every((v, i) => v === row[i + 1]));
  }
}
// Final-stop exposure.
for (const row of tables['Final-stop exposure']?.[0]?.rows ?? []) {
  const r = M('M11').rows.find(x => x.mode === modeName[row[0]]);
  const exp = [money(r.maxOneCargoCents), money(r.maxRoundGrossCents), money(r.maxRoundNetCents), r.pAtLeastOneReachesFinal, r.pAllThreeReachFinal];
  claim('§4', 'REPRODUCED', `Final-stop exposure ${row[0]}`, exp.join(' | '), row.slice(1).join(' | '), exp.every((v, i) => v === row[i + 1]));
}
// --- §6 maximum achievable RTP.
for (const row of tables['Maximum achievable RTP']?.[0]?.rows ?? []) {
  const r = M('M08').rows.find(x => x.mode === modeName[row[0]]);
  const exp = [money(r.bestTotalWagerCents), r.stakes.map(money).join('/'), r.targets.join('/'), r.maxRTP, r.minHouseEdge];
  claim('§6', 'REPRODUCED', `Maximum RTP ${row[0]}`, exp.join(' | '), row.slice(1, 6).join(' | '), exp.every((v, i) => v === row[i + 1]));
  claim('§6', 'UNVERIFIABLE', `Simulated RTP at optimum ${row[0]}`, null, row[6], true, 'Original random sample and audit-sim.mjs not retained.');
}
// --- §6 strategies at $30.
{
  const t = tables['Strategies compared']?.[0], cols = ['easy', 'medium', 'hard', 'expert'];
  const field = { 'All at first': 'allAtFirst', 'All at final': 'allAtFinal', 'A/B/C at 1/Mid/Final': 'abcAt1MidFinal', 'A at 1; B/C at Final': 'aAt1BCFinal', 'Adaptive rule above': 'adaptive', 'Optimal at $30': 'optimalAt30' };
  for (const row of t?.rows ?? []) {
    const f = field[row[0]], exp = cols.map(m => M('M10').rows.find(x => x.mode === m)[f]);
    claim('§6', 'REPRODUCED', `Strategy "${row[0]}"`, exp.join(' | '), row.slice(1).join(' | '), exp.every((v, i) => v === row[i + 1]));
  }
}
// --- Uneven-split examples in §6 prose.
{
  const opt = (w, m = 'easy') => { let best = null; for (let t = 1; t <= MODES[m].payouts.length; t++) { const v = survival(MODES[m].hazards, t).mul(payout(w, MODES[m].payouts[t - 1])); if (!best || v.cmp(best.v) > 0) best = { v, t }; } return best; };
  const total = W => { const parts = splitStake(W); return { parts, targets: parts.map(w => opt(w).t), rtp: parts.reduce((a, w) => a.add(opt(w).v), new Fraction(0)).div(W) }; };
  const a = total(301), b = total(302);
  const all4 = survival(1, 4).mul(payout(101, 123) + 2 * payout(100, 123)).div(301);
  claim('§6', 'REPRODUCED', '$3.01 Easy optimal targets and RTP', `targets ${a.targets.join('/')}, ${pct(a.rtp)}`, 'A→7, B/C→4, 98.421927%', a.targets.join('/') === '7/4/4' && pct(a.rtp) === '98.421927%');
  claim('§6', 'REPRODUCED', '$3.01 Easy all at stop 4', pct(all4), 'about 98.338870%', pct(all4) === '98.338870%');
  claim('§6', 'REPRODUCED', '$3.02 Easy optimal targets and RTP', `targets ${b.targets.join('/')}, ${pct(b.rtp)}`, 'A/B→7, C→4, 98.443709%', b.targets.join('/') === '7/7/4' && pct(b.rtp) === '98.443709%');
  const e = new Fraction(548, 555);
  claim('§6', 'REPRODUCED', 'Easy maximum worked example 0.8×137/111', pct(e), '548/555=98.738738…%', survival(1, 4).mul(payout(111, 123)).div(111).eq(e));
  for (const [m, w, cents, stop] of [['medium', 112, 276, 5], ['hard', 105, 138, 1], ['expert', 112, 220, 1]]) claim('§6', 'REPRODUCED', `${m} best stake ${w}¢ returns ${cents}¢ at stop ${stop}`, payout(w, MODES[m].payouts[stop - 1]), cents, payout(w, MODES[m].payouts[stop - 1]) === cents);
}
// --- Headline numbers in prose.
{
  const exact = new Fraction(548, 555), he = new Fraction(1).sub(exact);
  const headline = /\*\*(98\.\d+)%\*\*, using/.exec(text)?.[1], headlineHE = /house edge is \*\*(\d\.\d+)%\*\*/.exec(text)?.[1];
  claim('§1', 'REPRODUCED', 'Headline maximum RTP (6 dp)', pct(exact), headline + '%', headline + '%' === pct(exact),
    'Exact value 98.738738738…%; the §1/§10 text truncates to 98.738738% while §4/§6 tables round to 98.738739%.');
  claim('§1', 'REPRODUCED', 'Headline minimum house edge (6 dp)', pct(he), headlineHE + '%', headlineHE + '%' === pct(he),
    'Exact value 1.261261261…% (=7/555). Printed 1.261262% is neither truncated nor correctly rounded; §6 table prints 1.261261%.');
  const counts = Object.values(MODES).reduce((a, m) => a + Number(choose(20, m.hazards)), 0);
  claim('§1', 'REPRODUCED', 'Total hazard subsets', counts, '201,420', counts === 201420);
  claim('§1', 'REPRODUCED', 'Permitted total wagers', 300000 - 300 + 1, '299,701', true);
  claim('§1', 'REPRODUCED', 'Stake/multiplier pairs', 99901 * 61, '6,093,961', 99901 * 61 === 6093961);
  claim('§5', 'REPRODUCED', 'Settlement fixtures 61 × 5', 61 * 5, '305', true);
  claim('§9', 'REPRODUCED', 'Largest multiplication 100,000 × 18,106,088', 100000 * 18106088, '1,810,608,800,000', 100000 * 18106088 === 1810608800000);
  claim('§4', 'REPRODUCED', 'Max-bet Expert maximum gross (cents)', 3 * payout(100000, 18106088), '54,318,264,000', 3 * payout(100000, 18106088) === 54318264000);
  const expFinal = 3e6 / 184756;
  claim('§8', 'REPRODUCED', 'Expected Expert final survivors in 3M routes', expFinal.toFixed(4), '≈16.2376', expFinal.toFixed(4) === '16.2376');
  const varE = Number(M('M12').rows.find(r => r.mode === 'expert').variance), need = 1.959963984540054 ** 2 * varE / 0.01 ** 2;
  claim('§8', 'REPRODUCED', 'Expert rounds for ±1pp 95% half-width', (need / 1e9).toFixed(2) + ' billion', 'roughly 2.27 billion', (need / 1e9).toFixed(2) === '2.27');
}
// --- §8 simulation tables: internal arithmetic consistency of an unreproducible sample.
for (const [Name, key] of Object.entries(modeName)) {
  const t = tables[`${Name} — every simulated stop ($30 wager)`]?.[0];
  for (const row of t?.rows ?? []) {
    const s = Number(row[0]), m = MODES[key].payouts[s - 1] / 100, k = row[5].split('/').map(Number), n = k.reduce((a, b) => a + b, 0);
    const meanX = (k[1] + 2 * k[2] + 3 * k[3]) * m / 3 / n, ex2 = (k[1] + 4 * k[2] + 9 * k[3]) * (m / 3) ** 2 / n;
    const popVar = ex2 - meanX ** 2, sampVar = popVar * n / (n - 1);
    const S = survival(MODES[key].hazards, s).toNumber(), theoryRTP = S * m, tv = m * m * S * (1 - S) / 3, z = (meanX - theoryRTP) / Math.sqrt(tv / n);
    const checks = {
      countsSumTo1e6: n === 1e6,
      rtp: (meanX * 100).toFixed(5) + '%' === row[1],
      houseEdge: ((1 - meanX) * 100).toFixed(5) + '%' === row[2],
      hitRate: ((1 - k[0] / n) * 100).toFixed(5) + '%' === row[3],
      zeroReturn: ((k[0] / n) * 100).toFixed(5) + '%' === row[4],
      variance: Math.abs(sampVar - num(row[6])) <= 0.000005 * Math.max(1, num(row[6])) + 0.000005 || Math.abs(popVar - num(row[6])) <= 0.000005 * Math.max(1, num(row[6])) + 0.000005,
      z: Math.abs(z - num(row[7])) <= 0.0006
    };
    const ok = Object.values(checks).every(Boolean);
    claim('§8', 'CONSISTENT', `${Name} simulated stop ${s} figures derive from its own k-counts`, { rtp: (meanX * 100).toFixed(5) + '%', z: z.toFixed(3), var: sampVar.toFixed(5) }, row.slice(1).join(' | '), ok, ok ? undefined : checks);
  }
}
// Final-stop distribution table vs per-stop final rows; Wilson intervals; theory variance column.
for (const row of tables['Final-stop payout distribution']?.[0]?.rows ?? []) {
  const key = modeName[row[0]], last = tables[`${row[0]} — every simulated stop ($30 wager)`][0].rows.at(-1);
  const counts = row.slice(1).map(c => num(c.split('/')[0])).join('/');
  claim('§8', 'CONSISTENT', `${row[0]} final distribution matches per-stop final row`, last[5], counts, counts === last[5]);
  const payoutsOk = row.slice(1).every((c, k) => num(c.split('/')[1]) === k * 10 * MODES[key].payouts.at(-1) / 100);
  claim('§8', 'REPRODUCED', `${row[0]} final payout points k×$10×m`, 'k×$10×m', row.slice(1).map(c => c.split('/')[1].trim()).join(', '), payoutsOk);
}
for (const row of tables['Final-stop policy']?.[1]?.rows ?? []) {
  const key = modeName[row[0]];
  const theory = M('M12').rows.find(r => r.mode === key).variance;
  claim('§8', 'REPRODUCED', `${row[0]} theory variance`, theory, row[1], theory === row[1].replace(/,/g, ''));
  const survivors = Number(tables['Final-stop policy'][0].rows.find(r => r[0] === row[0])[6]);
  const [lo, hi] = wilson(survivors, 3e6), m = MODES[key].payouts.at(-1) / 100;
  const printed = row[3].replace(/%/g, '').split('–').map(Number), expLo = (lo * m * 100).toFixed(3), expHi = (hi * m * 100).toFixed(3);
  claim('§8', 'CONSISTENT', `${row[0]} 95% Wilson RTP interval from ${survivors} survivors`, `${expLo}%–${expHi}%`, row[3], Math.abs(printed[0] - Number(expLo)) <= 0.0015 && Math.abs(printed[1] - Number(expHi)) <= 0.0015);
}
// Evidence that cannot be checked.
for (const d of ['audit-math.mjs, audit-sim.mjs, audit-exploits.mjs, audit-extra.mjs, audit-findings.mjs and audit-results/*.json (only SHA-256 hashes recorded)',
  '18 additional adversarial test groups and 80 cash-out/elimination races (scripts absent)',
  'Browser session with $3.01 wager, captured API bodies, 100 browser-verified rounds',
  'Live private deployment equivalence (site behind authentication; not in scope)',
  '§7 forced 0xFFFFFFFF rejection on an in-memory copy (re-done independently in validate-rng.mjs R03)',
  'F03 measurement "≈888 histories" at the injected 2,000,000-byte limit (re-measured independently in validate-system.mjs S15)'])
  claim('§1/§12', 'UNVERIFIABLE', d, null, null, true);

const mismatches = results.filter(r => r.status === 'MISMATCH');
const out = { meta: { script: 'audit/validate-claims.mjs', node: process.version, generatedAt: new Date().toISOString(), source: 'CARGO_SAYCOVE_AUDIT.md' },
  summary: { total: results.length, matched: results.filter(r => r.status === 'MATCH').length, consistent: results.filter(r => r.status === 'CONSISTENT' && r.kind === 'CONSISTENT').length,
    unverifiable: results.filter(r => r.kind === 'UNVERIFIABLE').length, mismatches: mismatches.length, mismatchList: mismatches.map(r => `${r.section} ${r.description}`) }, claims: results };
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.error(`claims: ${out.summary.matched} matched, ${out.summary.consistent} consistent, ${out.summary.unverifiable} unverifiable, ${out.summary.mismatches} mismatches → ${outFile}`);
for (const m of mismatches) console.error('  MISMATCH', m.section, m.description, '| printed:', JSON.stringify(m.printed), '| expected:', JSON.stringify(m.expected));
