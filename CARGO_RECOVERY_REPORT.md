# Cargo project recovery report

**Date:** 7 October 2026
**Branch:** `claude/cargo-rtp-model-progress-jtepzy`, created from `main` at `13a9805`
**Scope:** establish a reliable, documented project state after an interrupted OpenAI Codex session. No production code, payout configuration, RNG behaviour or deployment settings were changed.

## 1. Summary

- The repository is intact and consistent. Production source is byte-identical to the commit audited in `CARGO_SAYCOVE_AUDIT.md` (`25d5181`).
- **No unfinished Codex work could be recovered.** There were no uncommitted changes, stashes or extra branches, no pull requests, and no copies of the audit's harness scripts. Nothing in the repository mentions a 96.8% RTP model. Any such work existed only on the machine where Codex ran and was never pushed. It is treated as **not done**.
- The only completed Codex deliverable is the committed audit (`CARGO_SAYCOVE_AUDIT.md`, commit `13a9805`). Its numerical claims were independently re-derived where possible. The results are in `CARGO_VALIDATION_REPORT.md`.
- The missing validation infrastructure has been rebuilt under `audit/` as deterministic, reproducible, non-production tooling.

## 2. Environment

| Item | Value |
| --- | --- |
| Execution | Ephemeral cloud container with a fresh clone of `github.com/sarimichael/cargo-game`. Not the machine Codex used |
| Node.js | System Node v22.22.0. Project declares `>=24`, so a checksum-verified Node **v24.21.0** was downloaded to a scratch directory outside the repo. All results below use v24.21.0 unless stated |
| OS | Linux x64, 4 vCPU |
| Network | Outbound HTTPS through a proxy. nodejs.org and the npm registry were reachable |

## 3. Repository state found

| Check | Result |
| --- | --- |
| `git status` | Clean. No staged, unstaged or untracked files |
| `git stash list` | Empty |
| Local branches | `main`, plus the designated work branch, both at `13a9805` |
| Remote branches (GitHub API) | `main` only (`13a9805`) |
| Pull requests (GitHub API) | None, open or closed |
| History | `3bba08f` setup and instructions → `25d5181` complete game import → `13a9805` audit report. All authored by `sarimichael` on 7 Oct 2026 |
| Tracked files | 41: the 40 from `25d5181` plus `CARGO_SAYCOVE_AUDIT.md` |
| `git diff --stat 25d5181 13a9805` | Only `CARGO_SAYCOVE_AUDIT.md` was added. **No production file changed after the audit** |

### Search for interrupted work

| Searched for | Where | Found |
| --- | --- | --- |
| `96.8`, `0.968`, `968`, `9680` | Every tracked file | Only incidental byte matches inside the two PNG images |
| `audit-math.mjs`, `audit-sim.mjs`, `audit-exploits.mjs`, `audit-extra.mjs`, `audit-findings.mjs`, `audit-results/` | Whole filesystem | Not present |
| Codex session state (`.codex*`) | Whole filesystem | Not present |
| Other branches, PRs or reflog entries | Local `.git` and GitHub API | None beyond the checkout itself |

**Conclusion.** The audit's evidence scripts are identified only by the SHA-256 hashes in its §12. Any "96.8% RTP model, independent cash-out and exposure" work was not saved to GitHub. It cannot be reconstructed from this repository, and no assumption is made that it was completed. If the original Codex workspace still exists on the user's machine, push it to a separate branch. It can then be compared with the rebuilt suite (see `HANDOFF_TO_CODEX.md` §6).

## 4. What the previous work actually completed

| Item | Evidence in repository | Recovery status |
| --- | --- | --- |
| Playable game, local server, hosted Worker, tests, docs | Commit `25d5181` | Present. All existing tests pass (§5) |
| Pre-integration audit report | `CARGO_SAYCOVE_AUDIT.md` (commit `13a9805`) | Present. Claims re-verified (see validation report) |
| Audit harness scripts and JSON results | Hashes only (audit §12) | **Missing.** Rebuilt independently in `audit/` |
| 96.8% RTP model | None | **Not found. Not started from this repository's point of view** |
| Fixes for F01–F11 | Audit §12 says none applied | Confirmed: production files equal `25d5181` |
| Live-site update | Not claimed by the audit | Not attempted (out of scope) |

## 5. Baseline verification of existing tests

| Command | Node 22.22.0 | Node 24.21.0 |
| --- | --- | --- |
| `npm test` (12 tests) | 12/12 pass | 12/12 pass |
| `npm run test:hosted` | Pass (experimental-SQLite warning) | Pass |
| `npm run test:collisions` | Pass | Pass |
| `npm ci && npm run build` | Not run | Pass; `dist/` produced. The built Worker bundle was also smoke-tested (bet + advance on in-memory SQLite) |
| `npm audit` | Not run | 4 moderate advisories, all in dev-only build tooling (esbuild ≤0.24 dev-server CORS, via drizzle-kit). This matches `docs/TESTED.md` |

`node_modules/` and `dist/` are git-ignored and were not committed.

## 6. Verifiability of the previous audit's findings

Detailed per-claim results are in `CARGO_VALIDATION_REPORT.md` and `audit/results/claims.json`.

| Audit area | Status after recovery |
| --- | --- |
| §2 rules, §3 model, §4 odds and payout tables (122 table rows) | **Reproduced exactly** from source |
| §4 final-stop exposure, §5 multiplier verification | **Reproduced** |
| §6 optimal-strategy maxima, strategy table, uneven-split examples | **Reproduced exactly**, including an independent joint Bellman solution |
| §1 headline "98.738738%" / "1.261262%" | **Minor mismatch.** Exact 548/555 rounds to 98.738739% and 1.261261%, as the audit's own §6 table shows |
| §7 RNG implementation claims | **Re-done independently** and confirmed |
| §8 simulation figures | **Not reproducible.** The random sample was not retained. All 61 per-stop rows are arithmetically self-consistent, and a new deterministic 4M-round simulation agrees with theory |
| §9 cash-out and exploit tests | **Re-done independently** on both adapters; same conclusions |
| F01, F03, F05, F07, F08, F09, F10, F11 | **Reproduced** with new scripts |
| F02, F04, F06 | Confirmed by code reading and exact maths (absence of a capability, or arithmetic facts) |
| Browser session, 100 browser-verified rounds, live deployment checks | **Unverifiable** here. No browser session was replayed, and the private site is outside scope |

## 7. Decisions taken

1. **New `audit/` directory.** Nothing is added under `test/`, and `package.json` is unchanged, so `npm test` keeps its original scope and the production package is unaffected.
2. **Deterministic seeds.** The simulation and fixtures derive seeds from SHA-256 rather than `newSeed()`, so every result can be regenerated bit-for-bit. Production `newSeed()` is still exercised for format and uniqueness (R06).
3. **Known defects as characterization tests.** They assert today's behaviour and fail deliberately once fixed, which prevents silent regressions and marks finished work.
4. **No push or merge.** As instructed, changes are committed locally on the work branch only. See `HANDOFF_TO_CODEX.md` §7 for the push command. *Note: the cloud container is ephemeral, so unpushed commits are lost when it is reclaimed.*
5. **The 96.8% model was not started.** It would require choosing a new payout ladder, which is a product decision that changes payout configuration. That is outside the authorised scope.
