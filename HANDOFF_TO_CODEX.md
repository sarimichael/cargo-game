# Handoff to Codex

Read this first. It tells you what state Cargo is in, what has already been verified, and how to continue without redoing work.

## 1. Repository state

| Item | Value |
| --- | --- |
| Repository | `sarimichael/cargo-game` (private) |
| Work branch | `claude/cargo-rtp-model-progress-jtepzy`, branched from `main` at `13a9805` |
| Commits on this branch | One recovery/validation commit (see §7). **Not pushed or merged** at the time of writing |
| Production code | **Unchanged.** Every tracked file outside `audit/` and the four new reports equals its blob at `25d5181`, the audited commit. `audit/run-all.mjs` re-checks this |
| Live site | Not touched. The hosting manifest and deployment settings were not modified |
| Node | `package.json` requires ≥24. Validated on v24.21.0 (and v22.22.0 for existing tests) |

## 2. What your previous session left behind

- **Saved:** `CARGO_SAYCOVE_AUDIT.md` (commit `13a9805`). It is accurate to its printed precision, apart from a rounding slip in its headline numbers (see N04).
- **Lost:** the audit harness (`audit-math.mjs`, `audit-sim.mjs`, `audit-exploits.mjs`, `audit-extra.mjs`, `audit-findings.mjs`, `audit-results/*.json`) and any **96.8% RTP model** work. None of it is in Git, on any branch or in any PR. If you still have the original workspace, see §6.

## 3. Work completed in this session

1. A recovery investigation (`CARGO_RECOVERY_REPORT.md`).
2. A rebuilt, deterministic validation suite in `audit/`. It uses only Node built-ins and needs no `npm install`. See `audit/README.md`.
3. Exact re-derivation of every mathematical claim (M01–M13), including:
   - an exhaustive sweep of 299,701 wagers and 6,093,961 payout pairs;
   - a joint Bellman program for 48 cases;
   - discovery of two exact rounding ties (N03).
4. A machine check of 250 numeric claims in the audit (`results/claims.json`).
5. An RNG structural review (R01–R08) and 108 pinned known-answer vectors.
6. A deterministic simulation of the unmodified production RNG: 4 × 1,000,000 rounds with statistical screens.
7. 21 adversarial system checks against both real adapters. These reproduce F01, F03, F05, F07, F08, F09, F10 and F11, and found N01.
8. 36 `node:test` regression tests, 14 of which characterise the known defects.
9. `CARGO_VALIDATION_REPORT.md`, with results, outstanding defects and uncertainties.

## 4. Tests executed (all passing)

| Command | Result |
| --- | --- |
| `node audit/run-all.mjs` | All steps exit 0. See `audit/results/manifest.json` |
| `node audit/validate-math.mjs` | 13/13 |
| `node audit/validate-claims.mjs` | 169 match, 69 consistent, 10 unverifiable, 2 mismatches (audit headline rounding, N04) |
| `node audit/validate-rng.mjs` | 8/8 |
| `node audit/simulate.mjs` + `analyze-simulation.mjs` | See validation report §6 |
| `node audit/validate-system.mjs` | 21/21 (12 safety hold, 7 defects reproduce, 2 observations) |
| `node --test audit/tests/*.test.js` | 36/36 |
| `npm test` / `npm run test:hosted` / `npm run test:collisions` | Pass / pass / pass |
| `npm ci && npm run build` | Pass; built Worker smoke-tested. `npm audit`: 4 moderate, dev-only |

## 5. Files changed

**Modified:** none.

**Added:**

```
CARGO_RECOVERY_REPORT.md
CARGO_VALIDATION_REPORT.md
HANDOFF_TO_CODEX.md
audit/README.md
audit/run-all.mjs
audit/simulate.mjs
audit/analyze-simulation.mjs
audit/validate-math.mjs
audit/validate-claims.mjs
audit/validate-rng.mjs
audit/validate-system.mjs
audit/lib/exact.mjs
audit/lib/reference-rng.mjs
audit/lib/seeds.mjs
audit/lib/stats.mjs
audit/lib/harness.mjs
audit/tests/math.test.js
audit/tests/rng.test.js
audit/tests/statemachine.test.js
audit/tests/adapters.test.js
audit/tests/known-defects.test.js
audit/results/math.json
audit/results/claims.json
audit/results/rng.json
audit/results/rng-vectors.json
audit/results/simulation-raw.json
audit/results/simulation.json
audit/results/system.json
audit/results/manifest.json
```

No `data/`, `.env`, credentials, database exports, `node_modules/` or `dist/` are included. All seeds in the results are derived test seeds, not live server seeds.

## 6. How to resume without repeating work

**Do not redo:**

- The exact-maths sweeps.
- The 4M-round simulation. Re-run it only if `server/fairness.js` or `public/math.js` changes; its `streamHash` per mode identifies the sample.
- The claim cross-check.
- The adversarial suite. Use `node audit/run-all.mjs --quick` (about 1 minute) as the gate after any change.

**Rules for any change to production code:**

1. Run `node audit/run-all.mjs --quick`, plus the project commands in `AGENTS.md`.
2. If a test in `audit/tests/known-defects.test.js` fails, you have fixed (or changed) that defect. Invert the test into a protective assertion and update the defect table in `CARGO_VALIDATION_REPORT.md` §7.
3. If `math.test.js` fails its ladder fingerprint, or `rng.test.js` fails its known-answer vectors, payout or RNG behaviour changed. That needs explicit approval (see `AGENTS.md`), a fix for F11 (version pinning) first, then `node audit/run-all.mjs --simulate` and a new fingerprint.

**Recommended next work, in priority order** (each item's acceptance evidence is in audit §12):

| # | Item | Notes |
| --- | --- | --- |
| 1 | **Decide the RTP target (owner decision).** Keep the current nominal 98% ladder, or adopt 96.8%? If 96.8%: should it be nominal like today, or a ceiling on best-play RTP? | Blocks any ladder work. Current best-play maximum is 98.738739% |
| 2 | F11 + N02: pin a math/rules version to each round; deep-freeze tables | Prerequisite for any ladder change, including 96.8% |
| 3 | N03: document half-up tie rounding; compute the ladder with exact rationals | Small doc/test change |
| 4 | F03: normalise storage (rounds, ledger, receipts in tables); bound the live session | Use S15 as the acceptance test |
| 5 | F05: final-port closure and recovery policy | Needs an owner decision on abandonment rules |
| 6 | F08, F10, N01: verifier schema; safe receipt map and canonical fingerprints; buffer-then-decode request bodies | Small, local fixes; flip the matching characterisation tests |
| 7 | F01, F02, F04, F07, F09: real-money boundary, wallet lifecycle, exposure limits, production store, quotas | Needs the Saycove spec and business decisions |

**If you recover your old workspace:** push it to a *new* branch (for example `codex/recovered-workspace`) without force-pushing or rewriting history. Then:

1. Compare its results with `audit/results/*.json`.
2. Compare its scripts' SHA-256 values with the table in `CARGO_SAYCOVE_AUDIT.md` §12.

**If you build the 96.8% model:**

- Write it as an *analysis* first, in `audit/` and using `audit/lib/exact.mjs`. Do not change `public/math.js` until the owner approves.
- Reuse the M07/M08/M09 machinery with `nominalMultiplier100(h, s, 968n)` divided by 10. Note that the helper takes the RTP in whole percent, so it needs a small generalisation to tenths of a percent.
- Account for tie rules (N03) and cent rounding. Under the current 98% ladder, best-play RTP exceeds the nominal target by up to 0.738739 percentage points. A 96.8% ladder's excess has **not** been computed: measure it, don't assume it.

## 7. Git: commit summary and commands

Changes are committed locally on the work branch. They are **not pushed**, as instructed.

Commit message used:

```
Add independent Cargo recovery and validation suite

Rebuilds the missing audit validation infrastructure as deterministic,
non-production tooling under audit/ and documents the recovered project state.
Production code, payout configuration, RNG and deployment settings are unchanged.
```

To publish for review (run from the repository root):

```sh
git status                      # expect a clean tree on claude/cargo-rtp-model-progress-jtepzy
git log --oneline -3            # recovery commit on top of 13a9805
node audit/run-all.mjs --quick  # optional re-check (~1 min)
git push -u origin claude/cargo-rtp-model-progress-jtepzy
# Then open a pull request into main for review. Do not merge without review.
```

If the commit has not been created yet in your checkout:

```sh
git checkout -b claude/cargo-rtp-model-progress-jtepzy 13a9805   # only if the branch is missing
git add CARGO_RECOVERY_REPORT.md CARGO_VALIDATION_REPORT.md HANDOFF_TO_CODEX.md audit/
git commit -m "Add independent Cargo recovery and validation suite"
```
