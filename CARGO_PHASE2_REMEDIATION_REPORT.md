# Cargo phase 2 remediation report

**Date:** 7 October 2026
**Branch:** `claude/cargo-phase2-safety-fixes`, created from the audit checkpoint. Not pushed or merged.
**Scope:** narrow, non-economic correctness and security fixes. Not changed: gambling mathematics, probabilities, payouts, the amounts or sequence of debits and credits, the RNG, engagement mechanics, deployment and hosting settings.

## 1. Starting point

| Item | Value |
| --- | --- |
| Starting commit | `724c954bc0137a461b3bee93c79247da0f5cbe81` (audit branch `claude/cargo-rtp-model-progress-jtepzy`, verified identical locally and on GitHub) |
| Audit checkpoint | Left untouched. The audit branch still points at `724c954` |
| Baseline before changes | All existing and audit suites green (see `CARGO_VALIDATION_REPORT.md`) |
| Runtime | Node.js v24.21.0 (primary); fast suites repeated on v22.22.0 |

## 2. Defects reviewed

Each finding was re-read in `CARGO_SAYCOVE_AUDIT.md` §9–§10 and `CARGO_VALIDATION_REPORT.md` §7 and re-checked against the code, not judged by its ID alone. Priority reflects reproducibility, security impact and risk of data corruption.

| ID | Documented nature (verified in code) | Reproducible | Impact | Decision |
| --- | --- | --- | --- | --- |
| N01 | `server/app.js` decoded each TCP chunk separately, so a multi-byte character split across chunks became U+FFFD. Invalid UTF-8 was silently replaced in both adapters | Yes (S20) | **Data corruption:** the round committed to a client seed the player did not choose | **Fixed** |
| F10 | Receipts were looked up as `s.receipts[id]`, so IDs like `constructor` hit `Object.prototype`, at **3 sites** including the Worker's compare-and-swap retry path. Fingerprints depended on JSON key order | Yes (S13) | Failed recovery and false conflicts after uncertain responses; no duplicate credit | **Fixed** |
| F08 | `verifyRound()` accepted altered algorithm, multiplier, nextRisk, maxStops, valueCents, round-ID format, timestamps, unknown fields, and duplicated or missing containers | Yes (S18) | Misleading dispute evidence marked "verified" | **Fixed** (one inherent limitation, §9) |
| N02 | `MODES` was frozen only at the top level; mode objects and payout arrays were mutable in-process | Yes | Enables silent in-process table drift (an aggravating factor for F11) | **Fixed** |
| F03 | One session row grows without bound. At the D1 2,000,000-byte limit, writes fail with 500 and a paid wager can be stranded | Yes (S15) | **Stranded money / frozen wallet** | **Mitigated** (stranding prevented); root cause deferred |
| N03 | The docs did not name a tie rule; Easy stop 4 (122.5) and Medium stop 4 (199.5) are exact ties | Yes (M04) | A re-implementation could pay 1.22× instead of 1.23× | **Fixed (documentation)** |
| N04 | Node version statements disagreed (≥24 in `package.json` and README; ≥22 enforced by `server/index.js`) | Yes | Confusion | **Fixed (documentation)**. The audit headline rounding slip is recorded here because `CARGO_SAYCOVE_AUDIT.md` is kept intact |
| F11 | Rounds do not pin the payout table they were accepted under | Yes (S19, redone as a deployment model) | Accepted wagers settle under a later table | **Deferred** (proposal §4). N02 closes only the in-process route |
| F01, F02, F04, F05, F06 | Free funding; external wallet lifecycle; exposure; final-port closure; RTP variation | Yes / by inspection | Economic or financial behaviour | **Deferred** (proposals §4) |
| F07, F09 | Multi-process local store; quotas, expiry and rate limits | Yes | Architecture and operational policy | **Deferred** (proposals §4) |

## 3. Defects corrected

Every fix followed the same steps: find the root cause, write a failing regression test, make the smallest fix, re-run, and check for side effects. **Evidence:** the final regression tests were run against the *original* code in a temporary worktree at `724c954`, where 10 failed. With the fixes, all 15 pass. The 5 tests that pass on both are deliberate guards: legacy-receipt compatibility, no false rejections by the verifier, the documented round-ID limitation, and the reserve-size measurement.

### N01: UTF-8 decoding across TCP chunks (LOW → fixed)
- **Root cause.** `for await (chunk of req) text += chunk` converts each Buffer to a string independently.
- **Fix.** Both adapters now collect raw bytes, enforce the same 16,384-byte limit on raw bytes, and decode once with `TextDecoder('utf-8', { fatal: true })` (`server/protocol.js#parseJsonObject`). Invalid UTF-8 returns **400** instead of being silently replaced.
- **Evidence.** Four seeds (2-, 3- and 4-byte characters and emoji sequences) split mid-character are stored intact. Four invalid sequences (overlong, surrogate, truncated, 0xFF) are refused on both adapters with no state change (`remediation.test.js`; S20).
- **Side effect, verified.** A UTF-8 byte-order mark before the JSON is now accepted by the local server. It already was by the Worker, which strips it. Before this change the two adapters disagreed (local 400, Worker 200); they now agree. Legitimate browser clients never send invalid UTF-8, since `JSON.stringify` escapes lone surrogates.

### F10: idempotency edge cases (LOW → fixed)
- **Root cause.** Prototype-chain lookup on a plain object, and a fingerprint over `JSON.stringify` (which preserves key order).
- **Fix.**
  - Own-property lookup (`findReceipt`).
  - Order-independent canonical fingerprints (`canonicalJSON`; serialised directly, so `__proto__` is treated as data).
  - Applied at all three sites: local transaction, Worker pre-check and Worker CAS-retry path.
  - **Backward compatible:** receipts written in the previous format still match, so retries that span a deployment keep replaying.
- **Evidence.**
  - All six `Object.prototype` names that satisfy the 8–80 character ID rule now execute once and then replay.
  - A key-reordered retry replays.
  - The same ID with a different body is still refused (409), with no duplicate credit.
  - A legacy-format receipt replays.
  - Covered on both adapters (S13).

### F08: verifier accepted altered metadata (MEDIUM → fixed)
- **Root cause.** `verifyRound()` recomputed only core outcomes and did not constrain the proof's structure.
- **Fix.** A strict `cargo-v1` schema in `public/fairness.js`, the same file used in the browser and by `tools/verify-round.mjs`:
  - exact key sets for round, proof and container objects;
  - algorithm must be `cargo-v1`;
  - UUID-format round ID; known difficulty; bet within limits; client-seed and nonce rules; commitment format;
  - exactly A/B/C in order and exactly three hazard decks;
  - ISO timestamps in order;
  - recomputed `valueCents`, `multiplier100`, `nextRisk` and `maxStops`.
- **Evidence.**
  - 24 tamper variants are rejected.
  - 40 naturally played rounds across all modes (including emoji, JSON-metacharacter and 128-character seeds, and an exported-JSON round trip) still verify.
  - The 1,500-round state-machine fuzz (every 10th proof verified) and R02 (192 rounds) still pass, so there are no false rejections.
  - In a real Chromium session, the **Verify round** button shows "verified", and the browser-loaded module rejects tampered copies (`results/browser.json`).

### N02: shallow-frozen payout configuration (LOW → fixed)
- **Fix.** Each mode object and payout array in `public/math.js` is frozen. The values are byte-for-byte unchanged: the ladder SHA-256 fingerprint test (`9719f45d…`) still passes and M04 still matches all 61 values.
- **Evidence.** Writes, `push`, and hazard reassignment throw `TypeError` in both Node and the browser.

### F03: stranded wager at the storage limit (HIGH → mitigated)
- **Fix (hosted adapter only).** Before accepting a **new** wager, the Worker measures the stored session in UTF-8 bytes. It refuses with **409 `SESSION_STORAGE_FULL`** and no change if fewer than `SETTLEMENT_RESERVE_BYTES` (64 KiB) would remain under the 2,000,000-byte D1 limit. Advances, collections, reads and replays are never refused by the guard, so an accepted round can always settle.
- **Reserve sizing.** A worst-case round grows the session by less than a quarter of the reserve (asserted in a test). That round is Easy, 19 stops, three separate collections, a 128-character escaped client seed and 80-character action IDs.
- **Evidence** (S15, real Worker, emulated D1 limit):
  - 870 normal rounds, then 8 worst-case rounds near the limit; every one settled.
  - **Zero** 500 responses.
  - The first refusal was 409 `SESSION_STORAGE_FULL` at 1,942,708 bytes (57,292 bytes of headroom).
  - Before the fix, the same run ended with HTTP 500 and the wallet frozen, and a boundary fixture showed a paid wager left active and uncredited.
- **Not changed.** No amount, odds or settlement changed; only *whether a new wager is accepted* when settling it could not be guaranteed. The root cause (unbounded growth; the session cannot start new voyages once full) remains open.

### N03 / N04: documentation
- `docs/FAIRNESS.md` now states half-up tie rounding, names both exact ties, and documents the strict verifier and its limitation.
- `docs/API.md` documents the UTF-8 400 response, key-order-independent replay, valid prototype-named IDs, legacy receipts, and the hosted `SESSION_STORAGE_FULL` contract.
- `README.md` clarifies the Node 24 / 22 policy.
- **Audit erratum** (recorded here; the audit file is not edited): §1/§10 "98.738738%" and "1.261262%" should read **98.738739%** and **1.261261%**.

## 4. Defects intentionally deferred (with remediation proposals)

| ID | Why deferred | Proposal |
| --- | --- | --- |
| **F11** (HIGH) | Touches the settlement path, so it needs owner approval even though no current payout would change | Introduce immutable versioned tables (for example `MATH_VERSIONS['cargo-v1-98']`). Stamp `mathVersion` on each round at bet time and settle, project and verify by the round's version; legacy rounds without the field map to `cargo-v1-98`. Acceptance test: `known-defects` F11 (deployment model) flips. **Prerequisite for any ladder change, including 96.8%** |
| **F03 root** (HIGH) | Schema migration and data model change | Split `rounds`, `ledger_entries` and `receipts` into indexed tables with unique constraints. Keep the session row bounded, with a retention policy that preserves idempotency evidence. Acceptance: S15 runs indefinitely with no refusal |
| **F05** (HIGH) | Changes settlement timing (automatic credit at the final port) and recovery policy | Owner-approved rule, for example auto-collecting survivors at the final stop when no decision remains, plus authenticated recovery. Disclose to players |
| **F01** (HIGH) | Funding is a financial behaviour | Separate demo from real-money mode; in real-money mode disable `/api/reset` and free starting credit, and require authenticated launch tokens |
| **F02** (HIGH) | Needs the Saycove wallet specification | Durable outbox / transaction state machine with stable IDs, ambiguous-result retries, rollback and reconciliation |
| **F04 / F06** | Economic (exposure, RTP) | Owner decision on exposure limits and RTP target (including whether 96.8% is nominal or a best-play ceiling). Re-run `validate-math.mjs` M07–M09 on any proposed ladder |
| **F07** (HIGH) | Local demo store only; architecture | Exclusive lock with stale-PID recovery plus `fsync`, or refuse a second process; never used for real money |
| **F09** (MEDIUM) | Operational policy | Server-side session expiry, per-IP/session rate limits (gateway or Worker), quotas and cleanup |
| Refill semantics (N04 note) | Changes ledger behaviour | Decide whether "refill" may lower a balance and whether 0¢ entries should be written |

## 5. Files modified

**Production (8):** `server/protocol.js` (new), `server/app.js`, `server/worker.js`, `public/fairness.js`, `public/math.js`, `docs/API.md`, `docs/FAIRNESS.md`, `README.md`.

**Byte-identical to the audited commit (checked by `run-all.mjs`):** `server/fairness.js` (RNG), `server/game.js` (engine), `server/store.js`, `public/collision.js`, `db/schema.ts`, `.openai/hosting.json`. Also unchanged: `public/app.js`, `public/scene.js`, `public/index.html`, `public/styles.css`, the drizzle migrations, the build scripts and all existing tests.

**Audit tooling:**
- New: `audit/tests/remediation.test.js`, `audit/lib/engine-variant.mjs`, `audit/browser-check.mjs`, `audit/results/browser.json`.
- Updated: `audit/tests/known-defects.test.js`, `audit/validate-system.mjs`, `audit/run-all.mjs`, `audit/README.md`, `audit/results/*.json` (regenerated).

**Reports:** this file (new). `CARGO_SAYCOVE_AUDIT.md`, `CARGO_RECOVERY_REPORT.md`, `CARGO_VALIDATION_REPORT.md` and `HANDOFF_TO_CODEX.md` are unchanged.

## 6. New and changed regression tests

| File | Tests | Purpose |
| --- | --- | --- |
| `audit/tests/remediation.test.js` | 15 (new) | N01 ×3, F10 ×6, F08 ×3, N02 ×1, F03 ×2. Protective tests for the fixes |
| `audit/tests/known-defects.test.js` | 9 (was 14) | F08, F10 ×2, N01 and N02 characterisations moved to protective tests. **F11 rewritten** to model a real deployment (`engine-variant.mjs`), since the deep freeze blocks the old in-process route. F11 itself is still open |
| `audit/validate-system.mjs` | 21 checks | New result types `remediated` (S13 F10, S18 F08, S20 N01) and `mitigated` (S15 F03). S19 F11 uses the deployment model |
| `audit/run-all.mjs` | — | Production-change allowlist and must-be-identical list; optional real-browser step |
| `audit/browser-check.mjs` | 2 viewports | Real Chromium 141: desktop 1440 px and phone 390 px, reduced motion |

## 7. Test results (final run, `node audit/run-all.mjs` with the browser step)

| Suite | Result |
| --- | --- |
| Exact mathematics (M01–M13) | 13/13. Unchanged except that M01 now records the tables as deeply frozen |
| Audit claim cross-check | 169 match / 69 consistent / 10 unverifiable / 2 known audit-text rounding slips. Unchanged |
| RNG structure (R01–R08) | 8/8. All 108 known-answer vectors unchanged |
| **RNG stream replay** | First 50,000 rounds of each mode regenerated (600,000 decks). Chunk hashes **identical** to the committed 4M-round simulation. The full simulation was not repeated |
| Simulation statistics | Re-analysed: unchanged (0 Bonferroni rejections) |
| System / adversarial (S01–S21) | 21/21: 12 safety hold, 3 remediated, 1 mitigated, 4 open defects still reproduce, 1 observation |
| Audit regression tests | **46/46** (Node 24 and Node 22) |
| Real browser | Pass on desktop and phone: UI verification, browser-loaded verifier, frozen table, no horizontal overflow, no console warnings or errors |
| `npm test` / `test:hosted` / `test:collisions` | 12/12 / pass / pass (Node 24 and Node 22) |
| `npm run build` | Pass. The built Worker bundle was smoke-tested (prototype-named ID, reordered replay, invalid UTF-8) |
| Production integrity | 8 intended changes, **0 unexpected, 0 protected files changed** |
| Secrets scan of the diff | No credentials, tokens, `.env`, `data/`, `dist/` or `node_modules/`; no new 64-hex values outside derived test results; hosting manifest unchanged |

There were no failing tests in the final run. During development, two test failures were traced to defects in my **new tests**, not the product, and a third test defect was caught in review before it ran. All were corrected before the evidence run:

- `valueOf` is shorter than the 8-character ID minimum, so 400 is correct.
- A padding fixture miscounted its own previous size.
- *(Caught in review.)* An S15 loop would have collected the same stop twice.

## 8. Remaining security and reliability issues

Open HIGH items: **F01, F02, F03 (root), F04, F05, F07, F11**. MEDIUM: **F06, F09**. The audit verdict, *not ready for real-money integration*, is unchanged.

## 9. Risks and limitations of this phase

- **Verifier strictness.** Any future change to the proof format must bump the algorithm (for example `cargo-v2`) and ship a matching verifier. Otherwise valid new proofs will be rejected.
- **Verifier cannot authenticate identity.** A different but well-formed round ID, or plausible timestamps, still verify, because they are not bound into the seed commitment. Event objects are replayed but extra fields inside events are not refused. Authenticating identity would need server-signed or externally anchored proofs.
- **Legacy fingerprints.** These are accepted indefinitely. They can be retired once all pre-change receipts have aged out.
- **Storage guard.**
  - It covers the hosted adapter only (the local file store has no row limit).
  - It assumes D1's documented 2,000,000-byte limit; the real D1 was **not** load-tested.
  - It adds one UTF-8 measurement of the session per bet.
  - Once triggered, the play session cannot start new voyages until the F03 root fix.
- **Real-browser coverage.** Chromium only; no Safari or Firefox runs.
- **The live private site is not updated.** Per `AGENTS.md`, deploying requires the Sites workflow and a separate approval. It was not attempted.

## 10. Recommended next phase

1. **Owner decisions:** the RTP target (98% nominal vs 96.8%, nominal or ceiling), the exposure limits (F04), and the final-port policy (F05).
2. **F11 math-version pinning**, then optionally a 96.8% ladder *analysis* in `audit/` using the M07–M09 machinery.
3. **F03 storage normalisation** with a migration plan and retention policy. Use S15 as the acceptance test.
4. **F09** expiry and rate limits; **F07** demo-store lock.
5. **Real-money preparation** (F01, F02) once the Saycove specification exists.
6. When approved: a Sites deployment of these fixes, following `AGENTS.md`.

## 11. Reproduction

```sh
git fetch origin claude/cargo-phase2-safety-fixes   # once published
git checkout claude/cargo-phase2-safety-fixes
node audit/run-all.mjs --quick                      # ~1 min
PLAYWRIGHT_MODULE=/path/to/playwright node audit/run-all.mjs   # full, including the browser step
```
