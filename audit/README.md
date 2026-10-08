# Cargo independent validation suite

Non-production tooling that re-creates the evidence behind `CARGO_SAYCOVE_AUDIT.md`. The original audit's harness scripts are not in the repository. This suite does not import, wrap or modify production behaviour except through the public functions and HTTP/Worker entry points that players already reach. Fault injection lives in test doubles: the SQLite D1 stand-in, a temporary `fs.writeFileSync` override in the test process, and test-only writes to stored session state.

Results and interpretation: [`../CARGO_VALIDATION_REPORT.md`](../CARGO_VALIDATION_REPORT.md). Hand-off: [`../HANDOFF_TO_CODEX.md`](../HANDOFF_TO_CODEX.md).

## Requirements

Node.js 24 or newer, as declared in `package.json`. Node 22.22 also runs everything; `node:sqlite` prints an experimental warning there. No `npm install` is needed: the suite uses Node built-ins only.

## Commands

| Command | What it does | Time* |
| --- | --- | --- |
| `node audit/run-all.mjs` | Every validator, all regression tests and the three existing test commands. Writes `results/manifest.json` | ~2 min |
| `node audit/run-all.mjs --quick` | Same, without the F03 2 MB capacity run | ~1 min |
| `node audit/run-all.mjs --simulate` | Also regenerates the 4,000,000-round simulation | ~25 min |
| `node --test audit/tests/*.test.js` | Fast regression tests only | ~15 s |
| `node audit/validate-math.mjs` | Exact maths (M01–M13) → `results/math.json` | ~5 s |
| `node audit/validate-claims.mjs` | Cross-checks every number printed in the audit → `results/claims.json` (needs `math.json`) | <1 s |
| `node audit/validate-rng.mjs` | RNG structure (R01–R08) and known-answer vectors → `results/rng.json`, `results/rng-vectors.json` | ~15 s |
| `node audit/simulate.mjs --rounds 1000000` | Deterministic Monte Carlo of the production `hazardDeck()` → `results/simulation-raw.json` | ~20 min |
| `node audit/analyze-simulation.mjs` | Statistical screens on the simulation → `results/simulation.json` | <1 s |
| `node audit/validate-system.mjs [--skip-capacity]` | Both real adapters: races, idempotency, validation, faults and defect reproductions (S01–S21) → `results/system.json` | ~1 min |
| `node audit/measure-storage.mjs` | F03 evidence: session composition per round and request cost vs stored size, both adapters → `results/storage.json` (timings indicative) | ~20 s |
| `PLAYWRIGHT_MODULE=… node audit/browser-check.mjs` | Real Chromium against the local server, desktop and 390 px phone: UI verification, browser-loaded verifier, frozen table, layout → `results/browser.json`. Optional; needs Playwright | ~30 s |
| `PLAYWRIGHT_MODULE=… node audit/browser-phase4a2.mjs [--root <checkout>]` | Real Chromium, desktop and phone: delayed reads vs newer actions (M1), a session vanishing during an action (M2), retrying an unconfirmed start (M3) → `results/browser-phase4a2.json`. `--root` runs another checkout's server and client (red baseline). Optional; needs Playwright | ~90 s |
| `PLAYWRIGHT_MODULE=… node audit/browser-phase4a3.mjs [--root <checkout>]` | Real Chromium, desktop and phone, against the real server run in-process: a session genuinely removed from storage while reads are outstanding, including the newest (M-01), and a different session at an equal revision reached by the natural poll (M-02) → `results/browser-phase4a3.json`. Every assertion is recorded by name. `--root` runs another checkout's server and client (red baseline). Optional; needs Playwright | ~2.5 min |
| `PLAYWRIGHT_MODULE=… node audit/browser-phase4a4.mjs [--root <checkout>] [--adapter local\|worker\|both]` | Real Chromium, desktop and phone, against the local server and the hosted Worker (on the harness's node:sqlite D1 stand-in, behind an HTTP bridge): a confirmation read overtaken by a newer unchanged poll (A → B → A), overlapping confirmations, and guards for replacements, unchanged polls and M-01 quarantine → `results/browser-phase4a4.json`. `--root` runs another checkout's server and client (red baseline). Optional; needs Playwright | ~4 min |

\*Measured on a 4-vCPU container.

## Determinism

- **Outcome-deterministic:** `validate-math`, `validate-claims`, `validate-rng`, `simulate`/`analyze-simulation` and the engine-level tests. Server seeds are derived as `SHA-256("cargo-audit-v1|<label>|<index>")` (`lib/seeds.mjs`), so re-running produces identical outcomes. The simulation's `streamHash` per mode identifies the exact sample, and the result does not depend on thread count.
- **Assertion-deterministic only:** `validate-system.mjs`, `measure-storage.mjs` and `tests/adapters.test.js` / `tests/known-defects.test.js` / `tests/reliability.test.js` / `tests/restart.test.js`. `restart.test.js` also depends on operating-system timing for where each SIGKILL lands. These drive the real HTTP and Worker adapters, which create sessions with production `newSeed()`, and seeds cannot be injected without changing production code. Game outcomes, and therefore counts such as icebergs or rounds-to-limit, vary slightly between runs. Every assertion is written to hold for any outcome; where an outcome must be fixed, hazards are forced through a test-only write to stored state.
- Test-action choices use a seeded SplitMix64 generator, never `Math.random`.
- **Non-deterministic by design:** R06 draws 10,000 values from production `newSeed()`, checking only their format and uniqueness. Timestamps, temporary directories and HTTP ports also vary.
- **Assumption:** derived SHA-256 seeds stand in for the OS CSPRNG. The suite tests the seed → deck mapping, not the host's entropy source.

## Layout

```
audit/
  lib/exact.mjs           BigInt rationals, combinatorics, reference split/payout (no production imports)
  lib/reference-rng.mjs   specification-only re-implementation of the hazard deck
  lib/seeds.mjs           deterministic seeds and action PRNG
  lib/stats.mjs           chi-square, Wilson, Pearson (diagnostic only)
  lib/harness.mjs         drives server/app.js over HTTP and server/worker.js on node:sqlite
  validate-*.mjs          validators that write results/*.json
  simulate.mjs, analyze-simulation.mjs
  lib/engine-variant.mjs  isolated engine copy with a modified table (models a later deployment, F11)
  browser-check.mjs       optional real-browser check (Playwright)
  browser-phase4a2.mjs    optional real-browser state-reliability checks, phase 4A.2 (Playwright)
  browser-phase4a3.mjs    optional real-browser state-consistency checks, phase 4A.3 (Playwright)
  browser-phase4a4.mjs    optional real-browser confirmation-ordering checks, local and Worker, phase 4A.4 (Playwright)
  run-all.mjs             one-command reproduction plus manifest and production-change allowlist
  tests/*.test.js         node:test regression tests:
                            remediation.test.js   protective tests for defects fixed in phase 2
                            known-defects.test.js characterises defects that are still open
                            reliability.test.js   phase 3: persistence, concurrency, ordering, storage faults,
                                                  input fuzz, session lifecycle, configuration versions
                            restart.test.js       phase 3: real server processes killed with SIGKILL; F07
                            phase4a3.test.js      phase 4A.3: server premises of the browser's equal-revision check
                                                  (coverage rule independent of voyage length since 4A.4)
  results/                committed outputs of the run recorded in the reports
```

## Reading results

Each validator check records `assumption`, `method` and its measured fields. In `system.json` the `type` field matters:

- `safety`: `pass` means the protective property held.
- `remediated`: a defect fixed in phase 2; `pass` means the corrected behaviour held.
- `mitigated`: the harmful consequence is prevented, but the root cause is still open.
- `defect`: `pass` means the previously reported defect still reproduces. This is not a safety pass.
- `observation`: recorded behaviour with no judgement.

The tests in `tests/known-defects.test.js` assert the current defective behaviour. When a defect is fixed, its test will fail on purpose. Move it into `tests/remediation.test.js` as a protective test at that point.

`run-all.mjs` compares every production file with the audited commit `25d5181`. Files may differ only if they appear in its `INTENDED_CHANGES` list, and the RNG and engine files in `MUST_BE_IDENTICAL` must stay byte-identical.
