// One-command reproduction of the whole validation suite.
//
// Usage:
//   node audit/run-all.mjs            # everything except re-simulating (re-analyses existing simulation-raw.json)
//   node audit/run-all.mjs --quick    # also skips the ~40 s F03 capacity run
//   node audit/run-all.mjs --simulate # also re-runs the 4,000,000-round simulation (~20 min on 4 cores)
//
// Writes audit/results/manifest.json: Node/Git identity, exit codes, durations and
// SHA-256 of every audit script and result, plus a production-integrity check that
// compares every production file with the audited commit.
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const AUDITED_COMMIT = '25d5181fbd82abbd22aaea4b32f546e94f9c3602';
// Production files intentionally changed since the audited commit (phase 2, CARGO_PHASE2_REMEDIATION_REPORT.md).
// Any other difference fails the run. The RNG and the authoritative engine must remain byte-identical.
const INTENDED_CHANGES = ['server/app.js', 'server/worker.js', 'server/protocol.js', 'public/math.js', 'public/fairness.js', 'docs/API.md', 'docs/FAIRNESS.md', 'README.md',
  // Phase 4A (CARGO_PHASE4A_REMEDIATION_REPORT.md): F07 folder lock, P3-02 client recovery, documentation.
  'server/lock.js', 'server/store.js', 'server/index.js', 'public/app.js', 'docs/INTEGRATION.md'];
const MUST_BE_IDENTICAL = ['server/fairness.js', 'server/game.js', 'public/collision.js', 'db/schema.ts', '.openai/hosting.json'];
// Payout tables, settlement engine, RNG, proof verifier and collision mapping must also be unchanged
// since the Phase 4A base commit (they were last changed, deliberately, in phase 2).
const PHASE_BASE = 'fca90c6b0da2ecabe3339db81c00fc3145dfbdcd';
const UNCHANGED_SINCE_PHASE_BASE = ['public/math.js', 'public/fairness.js', 'server/game.js', 'server/fairness.js', 'public/collision.js'];
const quick = process.argv.includes('--quick'), simulate = process.argv.includes('--simulate');
const node = process.execPath, steps = [];
function run(label, args, { optional = false } = {}) {
  const t = Date.now(); console.error(`\n▶ ${label}`);
  const r = spawnSync(args[0] === 'npm' ? 'npm' : node, args[0] === 'npm' ? args.slice(1) : ['--no-warnings', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: path.dirname(node) + path.delimiter + process.env.PATH } });
  const tail = (r.stdout + r.stderr).trim().split('\n').filter(l => !/ExperimentalWarning|trace-warnings|npm notice/.test(l)).slice(-6);
  steps.push({ label, command: args.join(' '), exitCode: r.status, seconds: +((Date.now() - t) / 1000).toFixed(1), tail, optional });
  console.error(tail.join('\n'));
  return r.status;
}
const git = (...a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; } };

// Production integrity: every tracked non-audit file must equal its blob in the audited commit.
const tracked = git('ls-files').split('\n').filter(f => f && !f.startsWith('audit/') && !/^(CARGO_.*\.md|HANDOFF_TO_CODEX\.md)$/.test(f));
const changed = tracked.filter(f => { const now = git('hash-object', f), then = git('rev-parse', '--verify', '--quiet', `${AUDITED_COMMIT}:${f}`); return now !== then; });
const unexpected = changed.filter(f => !INTENDED_CHANGES.includes(f)), protectedChanged = MUST_BE_IDENTICAL.filter(f => changed.includes(f));
const changedSincePhaseBase = UNCHANGED_SINCE_PHASE_BASE.filter(f => git('hash-object', f) !== git('rev-parse', '--verify', '--quiet', `${PHASE_BASE}:${f}`));

if (simulate) run('Monte Carlo simulation (4×1,000,000 rounds)', ['audit/simulate.mjs', '--rounds', '1000000']);
run('Exact mathematics', ['audit/validate-math.mjs']);
run('Audit claim cross-check', ['audit/validate-claims.mjs']);
run('RNG structure', ['audit/validate-rng.mjs']);
if (fs.existsSync(path.join(root, 'audit/results/simulation-raw.json'))) run('Simulation statistics', ['audit/analyze-simulation.mjs']);
run('System / adversarial', ['audit/validate-system.mjs', ...(quick ? ['--skip-capacity'] : [])]);
if (!quick) run('Storage growth and request cost (F03)', ['audit/measure-storage.mjs']);
run('Audit regression tests', ['--test', ...fs.readdirSync(path.join(root, 'audit/tests')).filter(f => f.endsWith('.test.js')).map(f => 'audit/tests/' + f)]);
// Optional real-browser check: runs only when Playwright can be resolved (PLAYWRIGHT_MODULE or a normal install).
const playwright = process.env.PLAYWRIGHT_MODULE || (() => { try { return createRequire(import.meta.url).resolve('playwright'); } catch { return null; } })();
if (playwright) run('Real browser (desktop + phone)', ['audit/browser-check.mjs']);
else steps.push({ label: 'Real browser (desktop + phone)', command: 'audit/browser-check.mjs', exitCode: null, skipped: 'Playwright not found; set PLAYWRIGHT_MODULE', optional: true });
run('Existing: npm test', ['npm', 'test']);
run('Existing: npm run test:hosted', ['npm', 'run', 'test:hosted']);
run('Existing: npm run test:collisions', ['npm', 'run', 'test:collisions']);

const sha = f => createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');
const files = [...fs.readdirSync(path.join(root, 'audit'), { recursive: true })].map(f => 'audit/' + f.split(path.sep).join('/'))
  .filter(f => fs.statSync(path.join(root, f)).isFile() && !f.endsWith('manifest.json') && !f.includes('/.store-')).sort();
const manifest = { generatedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, gitHead: git('rev-parse', 'HEAD'), gitBranch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  auditedCommit: AUDITED_COMMIT, productionIntegrity: { filesCompared: tracked.length, changedSinceAuditedCommit: changed, intendedChanges: INTENDED_CHANGES, unexpectedChanges: unexpected, mustBeIdentical: MUST_BE_IDENTICAL, protectedFilesChanged: protectedChanged, phaseBase: PHASE_BASE, unchangedSincePhaseBase: UNCHANGED_SINCE_PHASE_BASE, changedSincePhaseBase },
  mode: simulate ? 'full+simulate' : quick ? 'quick' : 'full',
  steps, allPassed: steps.every(s => s.exitCode === 0 || s.skipped) && unexpected.length === 0 && protectedChanged.length === 0 && changedSincePhaseBase.length === 0, sha256: Object.fromEntries(files.map(f => [f, sha(f)])) };
fs.writeFileSync(path.join(root, 'audit/results/manifest.json'), JSON.stringify(manifest, null, 1));
console.error(`\n${manifest.allPassed ? 'ALL PASSED' : 'FAILURES PRESENT'} — production files changed since audited commit: ${changed.length} (${changed.join(', ') || 'none'}); unexpected: ${unexpected.length}; protected changed: ${protectedChanged.length}; payout/settlement/RNG changed since ${PHASE_BASE.slice(0, 7)}: ${changedSincePhaseBase.length}; manifest → audit/results/manifest.json`);
process.exitCode = manifest.allPassed ? 0 : 1;
