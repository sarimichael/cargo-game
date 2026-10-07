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

\*Measured on a 4-vCPU container.

## Determinism

- **Outcome-deterministic:** `validate-math`, `validate-claims`, `validate-rng`, `simulate`/`analyze-simulation` and the engine-level tests. Server seeds are derived as `SHA-256("cargo-audit-v1|<label>|<index>")` (`lib/seeds.mjs`), so re-running produces identical outcomes. The simulation's `streamHash` per mode identifies the exact sample, and the result does not depend on thread count.
- **Assertion-deterministic only:** `validate-system.mjs` and `tests/adapters.test.js` / `tests/known-defects.test.js`. These drive the real HTTP and Worker adapters, which create sessions with production `newSeed()`, and seeds cannot be injected without changing production code. Game outcomes, and therefore counts such as icebergs or rounds-to-limit, vary slightly between runs. Every assertion is written to hold for any outcome; where an outcome must be fixed, hazards are forced through a test-only write to stored state.
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
  run-all.mjs             one-command reproduction plus manifest
  tests/*.test.js         node:test regression tests (known-defects.test.js characterises unfixed defects)
  results/                committed outputs of the run recorded in the reports
```

## Reading results

Each validator check records `assumption`, `method` and its measured fields. In `system.json` the `type` field matters:

- `safety`: `pass` means the protective property held.
- `defect`: `pass` means the previously reported defect still reproduces. This is not a safety pass.
- `observation`: recorded behaviour with no judgement.

The tests in `tests/known-defects.test.js` assert the current defective behaviour. When a defect is fixed, its test will fail on purpose. Invert it into a protective test at that point.
