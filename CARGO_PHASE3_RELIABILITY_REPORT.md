# Cargo phase 3 reliability and state-integrity report

**Date:** 7 October 2026
**Branch:** `claude/cargo-phase3-reliability-review`. Not pushed or merged.
**Scope:** review and tests only. **No production file was changed in this phase** (verified: `git diff da135aa -- <production paths>` is empty). Payouts, wagers, the RNG, settlement and deployment are untouched. Every correction below is a *proposal* awaiting approval.

## 1. Starting checkpoint

| Item | Value |
| --- | --- |
| Starting commit | `da135aae69ad95e3357910b4377721685c38498a` (`claude/cargo-phase2-safety-fixes`, identical locally and on GitHub) |
| Baseline | `node audit/run-all.mjs --quick` passed all checks: 46/46 regression tests, 21/21 system checks, browser, existing tests. The committed `audit/results/` were restored afterwards so the quick run did not overwrite full evidence |
| Runtime | Node.js v24.21.0. New tests repeated on v22.22.0 |
| Simulation | Not re-run. The RNG and engine files are byte-identical to the audited commit |

## 2. Reviewed defects

Each finding was re-read in `CARGO_SAYCOVE_AUDIT.md` §9–§10, `CARGO_VALIDATION_REPORT.md` §7 and `CARGO_PHASE2_REMEDIATION_REPORT.md` §4, then re-checked against the current code. Line references are to `da135aa`.

### F11: payout configuration is not pinned to a round. HIGH, impact wider than previously reported
- **Root cause.** A round stores `difficulty` and the label `algorithm: 'cargo-v1'` (`server/game.js:41`) but not the table it was accepted under. Several functions all read the live `MODES` table at the time they run:
  - settlement (`collectRound`, `game.js:69`);
  - display (`publicRound`, `game.js:82`);
  - the step bound (`advanceRound`, `game.js:51`);
  - verification (`public/fairness.js`).
- **Reproduction** (`reliability.test.js`, `known-defects.test.js`, `system.json` S19; an isolated engine and Worker copy models the next deployment):
  1. An accepted 1.03× round settles at 1.04× (already known).
  2. **New:** a genuine settled proof that verified before the deployment is **rejected** afterwards ("A payout is inconsistent"), and history re-displays it at 1.04×.
  3. **New:** if a deployment shortens a mode (Expert loses stop 10), a round already at stop 10 can no longer be collected (500). The **whole session becomes unreadable**: `GET /api/session` → 500, because `snapshot()` → `publicRound()` → `payout(stake, undefined)` throws. The wager is stranded.
- **Affected:** `server/game.js`, `public/math.js`, `public/fairness.js`, both adapters, exported proofs, round history.
- **Dependencies:** must precede any table change, including a 96.8% ladder.
- **Proposed remediation (settlement path; needs approval):**
  - Keep immutable, versioned tables, for example `MATH_VERSIONS = { 'cargo-v1-98': … }`.
  - At bet time, store `mathVersion` on the round.
  - Make `collectRound`, `advanceRound`, `publicRound` and `verifyRound` resolve the table from the round.
  - Map legacy rounds without the field to `cargo-v1-98`.
  - Never delete a version that any stored round references, and add a startup check that refuses to boot otherwise.
- **Compatibility risks:**
  - One new field in stored rounds and proofs. The Phase 2 strict verifier refuses unknown fields, so the proof schema must move to a new algorithm label (`cargo-v2`) while still accepting `cargo-v1`.
  - Proofs must embed or name the version.

### F03: unbounded single-record session storage. HIGH (stranding mitigated in Phase 2; root cause open)
- **Root cause.** The whole wallet (all rounds with revealed seeds and event logs, every ledger entry and every idempotency receipt) is one JSON value. It is parsed and rewritten on every request: the D1 row (`server/worker.js:58`) and the local `state.json` (`server/store.js:14-18`). Nothing is ever pruned.
- **Measurements** (`results/storage.json`, `measure-storage.mjs`):
  - **Size:** about **2,176 bytes per ordinary round**. Of that, round records are 48% (about 1 KB each), the ledger 34% (3.86 entries per round) and receipts 18% (3 per round). The response stays about 5 KB because only 20 history rows are returned.
  - **Request cost grows linearly with stored size:**

    | Session size | Worker GET / POST | Local GET / POST |
    | --- | --- | --- |
    | 19 KB | 0.43 / 0.61 ms | 1.13 / 2.37 ms |
    | 1.9 MB | 9.8 / 18.5 ms | 1.7 / 32.9 ms |

    The local POST is dominated by `structuredClone` plus a full-file rewrite. These are indicative timings from an in-memory stand-in.
  - **Capacity:** the Phase 2 guard now refuses new voyages after about 870 rounds (S15). The session then stays usable for reads but cannot start voyages.
- **Affected:** both adapters, `db/schema.ts`, drizzle migrations.
- **Dependencies:** F11 (a version field), F09 (retention), F02 (transaction records).
- **Proposed remediation (data model; needs approval because it moves ledger persistence):**
  - Tables `sessions` (small), `rounds` (one row per round), `ledger_entries` (unique `id`) and `receipts` (unique `(session_id, action_id)`), written in one D1 batch with the existing revision check on `sessions`.
  - Keep the snapshot's last-20 history as an indexed query.
  - Retention: archive settled rounds, but keep receipts for at least the retry window.
  - Migrate existing JSON sessions lazily on first write.
- **Compatibility risks:**
  - Mixed old and new rows during migration, and D1 batch-size limits.
  - The local file store needs an equivalent design or must stay demo-only (see F07).

### F07: local file store has no cross-process protection. HIGH for any multi-process use (demo-only by design)
- **Root cause.** Each `Store` loads `state.json` once at startup (`server/store.js:8`) and later overwrites the whole file from its own in-memory copy (`:17-18`). There is no lock, no detection of another writer and no `fsync`.
- **Reproduction:**
  - **New, end-to-end with two real server processes** (`restart.test.js`): process A accepted a $30 bet; process B, started on the same directory, then served one request. **A's session, debit and active voyage disappeared from disk.**
  - Earlier in-process reproduction: S17.
  - Single-process crash safety is good: under 6 SIGKILLs during live play, every acknowledged action survived and the file always parsed (atomic rename).
  - Power-loss durability (no `fsync`) remains **untested**.
- **Affected:** `server/store.js`, `server/index.js`, `START-CARGO.cmd` users who double-start.
- **Dependencies:** none.
- **Proposed remediation (non-financial; can be implemented after approval):**
  - At startup, take an exclusive lock file (`state.lock`, opened with `wx`) recording the PID; refuse to start if a live process holds it, and recover the lock if that process is dead.
  - Optionally `fsync` the temp file and directory before rename.
  - Keep the documented single-process limit.
- **Compatibility risks:**
  - A stale lock after a crash needs PID recovery.
  - Windows file semantics differ, and `START-CARGO.cmd` would need a friendly "already running" message.

### F05: unfinished-round recovery and final-port closure. HIGH
- **Root cause:**
  - Survivors at the final port stay `active` until an explicit collect (`game.js:51`: advance refused; no automatic closure).
  - Round ownership is only the anonymous cookie.
  - **New (P3-02):** an unknown but well-formed cookie on `GET /api/session` silently creates a **new funded session** (`server/app.js:46`, `server/worker.js:29`). So a lost session (cleanup, F07 overwrite, deletion) is masked: the player sees a fresh $1,000 wallet and the debited wager is never surfaced.
- **Reproduction:**
  - Final-port survivors remain uncredited across crashes and restarts, and collect normally afterwards (`restart.test.js`; S16).
  - A deleted session row → POST 401 → GET returns a new wallet with `round: null` (`reliability.test.js`, both adapters).
- **Affected:** `server/game.js`, both adapters, the client's session bootstrap.
- **Dependencies:** authenticated launch (F01), storage (F03), operator recovery tooling.
- **Proposed remediation:**
  - **Technical, non-financial:** return a distinct response (for example `SESSION_NOT_FOUND`) for a well-formed cookie whose session no longer exists, instead of silently minting a wallet; log it for support.
  - **Financial, deferred:** auto-closure of final-port voyages, abandonment policy, operator recovery.
- **Compatibility risks:** the client must handle the new response, for example by offering "start a new play session".

### F01: free play-money creation and refill. HIGH in a real-money context
- **Root cause:** `createSession()` grants $1,000 (`game.js:9`), and `resetWallet()` restores $1,000 on request (`game.js:76`; route at `app.js:72`, `worker.js:55`). Neither checks an operator identity.
- **Reproduction:** `known-defects.test.js` (both adapters), S14, and the P3-02 test (a new funded wallet per unknown cookie).
- **Affected:** both adapters, `public/app.js` refill UI.
- **Dependencies:** a Saycove launch/authentication specification.
- **Proposed remediation:** a server-side `MODE=demo|real` boundary; in real mode, reject `/api/reset` and starting credit and require signed launches. **Financial: deferred to an owner decision.**
- **Compatibility risks:** the demo must keep working unchanged.

### F02: no external wallet transaction lifecycle. HIGH (absent capability)
- **Root cause:** all money movement ends in the internal `entry()` (`game.js:12`). There is no debit/credit acknowledgement, rollback, status query or reconciliation.
- **Reproduction:** absence confirmed by code reading; internal exactly-once behaviour is strong (S01–S05, S11, S12, the SIGKILL test).
- **Dependencies:** the Saycove wallet specification; F03 (durable transaction records); F11.
- **Proposed remediation:** a durable outbox or transaction state machine (pending → acknowledged / failed / reversed) with stable IDs and reconciliation. **Financial: deferred.**
- **Compatibility risks:** settlement becomes asynchronous; client state needs a pending status.

### F09: no session expiry, quotas or rate limits. MEDIUM
- **Root cause:**
  - Stored sessions have **no lifecycle timestamps** at all (no created, last-seen or expiry fields); confirmed in tests.
  - The 30-day cookie `Max-Age` (`app.js:47`, `worker.js:32`) is not enforced server-side.
  - Every cookieless GET persists a new session (`app.js:46`, `worker.js:29-30`).
  - There is no rate limiting.
- **Reproduction:** `known-defects.test.js` F09 (5 GETs → 5 stored sessions), `reliability.test.js` F05/F09, S14.
- **Dependencies:** F03 (retention needs per-row storage), the hosting gateway configuration (not inspected; access is private).
- **Proposed remediation (technical):**
  - Add `createdAt`, `lastSeenAt` and `expiresAt` to new sessions.
  - Reject expired sessions with a distinct code, and add a periodic cleanup that never deletes sessions with active rounds.
  - Defer creating the stored session until the first mutation, or rate-limit creation per client at the gateway.
- **Compatibility risks:**
  - Existing rows lack the fields and must be treated as "unknown age", not expired.
  - Cleanup must coordinate with F05 recovery and F03 retention.

### P3-01 (new): deeply nested JSON returns 500 instead of 400. LOW; partly a Phase 2 regression
- **Root cause.** Both adapters fingerprint the parsed body before validating its shape (`app.js:61`, `worker.js:45`):
  - The Phase 2 `canonicalJSON` is recursive (`server/protocol.js:25-27`) and overflows the stack from nesting depth **3,011** (Node 24) / **2,983** (Node 22).
  - The legacy `JSON.stringify` fingerprint overflows from **4,458 / 4,165**.
  - A 16 KB body can nest about **8,162** levels.
- **Reproduction:** `reliability.test.js` P3-01 (depth 5,000): HTTP 500 `SERVER_ERROR` on both adapters, **no state change**; depth 64 → 200.
- **Impact:** only an incorrect error class and an error-log line per request. There is no data corruption or security exposure, and legitimate clients never nest beyond a few levels. **Phase 2 lowered the failing threshold from about 4,200 to about 3,000.**
- **Proposed remediation (technical):** in `parseJsonObject`, reject bodies whose nesting depth exceeds a small bound (for example 32) with 400, before fingerprinting; or make `canonicalJSON` iterative. Add the existing P3-01 test inverted.
- **Compatibility risks:** none for real clients, whose maximum depth is 2.

## 3. Reproduction results summary

| ID | Status after Phase 3 | Evidence |
| --- | --- | --- |
| F11 | Reproduced; **wider impact** (proof invalidation, bricked sessions) | 3 tests + S19 |
| F03 | Reproduced and quantified; stranding prevented (Phase 2) | `storage.json`, S15, F03 test |
| F07 | Reproduced **with real processes** (data loss) | `restart.test.js`, S17 |
| F05 | Reproduced; **plus P3-02** (lost session masked by a new wallet) | 2 tests + S16 |
| F01 | Reproduced | 2 tests + S14 |
| F02 | Confirmed absent (code review) | n/a |
| F09 | Reproduced; no lifecycle fields exist | 4 tests + S14 |
| P3-01 | **New**; partial regression from Phase 2 | 2 tests |
| Phase 2 fixes (N01, F08, F10, N02, F03 guard) | **Still effective** | `remediation.test.js` 15/15, S13/S15/S18/S20 |

## 4. New tests and outcomes

All 29 new tests pass on Node 24.21.0 and Node 22.22.0. Synthetic play money, temporary directories, test-only fixtures; no production code was modified.

| Required area | Tests (`reliability.test.js` unless marked) | Outcome |
| --- | --- | --- |
| State persistence and recovery | In-process restart keeps the active round, wallet and receipts (pre-restart action replays; play continues); stale `state.json.tmp` ignored; truncated/empty/unknown-version `state.json` fails closed | Pass |
| Concurrent requests | 8 sessions × 10 rounds in parallel per adapter (isolation, ledger and round invariants); reset racing a bet at the same revision ×10 | Pass |
| Duplicate or reordered requests | Out-of-order delivery → `STALE_REVISION`, then applies in order; very late duplicate bet → replay, no debit (returns the latest snapshot, as documented); same ID in two sessions independent | Pass |
| Partial storage failures | Local rename failure after the temp write → 500, memory and disk unchanged, retry once; Worker session-insert failure → 500 and **no cookie** issued; Worker read failure → 500, no change; post-commit failure on collect → retry replays, 3 credits exactly | Pass |
| Invalid input handling | 400 deterministic fuzzed requests per adapter (random shapes, prototype keys, duplicate keys, 1e309, BOMs, non-objects; outcomes 200/400/404/409): **never 500, never a state change unless accepted**; P3-01 characterisation | Pass (P3-01 characterised) |
| Session lifecycle consistency | Malformed (upper-case, short, long, path-like) and duplicated cookies → 401 with no cross-session fall-through; lost-session masking (P3-02) and missing lifecycle fields characterised | Pass |
| Configuration version consistency | F11 proof invalidation and re-projection; shortened table bricks the session (both via the real Worker running an isolated next-deployment build on the same database) | Characterised |
| Unexpected server restarts | `restart.test.js`: real server SIGKILLed 6 times during live play (observed in three runs: 150–157 acknowledged actions each; 2–5 requests in flight at kills, all retried; across runs both outcomes occurred: a retry replayed a request committed before the kill, and a retry applied a lost request exactly once; the file was always valid and the ledger reconciled); active and final-port voyages survive crashes and settle afterwards; fresh Worker isolate continues and replays; F07 two-process data loss | Pass / F07 characterised |

**Full validation** (`node audit/run-all.mjs` with the browser step):
- **Audit checks:** 13/13 maths; claims unchanged; 8/8 RNG; simulation re-analysis unchanged; 21/21 system checks (12 safety, 3 remediated, 1 mitigated, 4 open defects reproduce, 1 observation); the storage measurement ran.
- **Regression tests:** **75/75** (46 earlier and 29 new).
- **Browser:** desktop and phone pass.
- **Existing tests and build:** `npm test` 12/12, `test:hosted` and `test:collisions` pass, and `npm run build` passes.
- **Production integrity:** 0 unexpected changes, and the protected RNG and engine files are byte-identical.

## 5. Proposed technical corrections (awaiting approval; none implemented)

Ordered by risk reduction per unit of change. Items 1–4 do not touch payouts, wagers, the RNG or settlement.

| # | Change | Fixes | Files | Acceptance test |
| --- | --- | --- | --- | --- |
| 1 | Nesting-depth limit (or iterative canonicalisation) before fingerprinting | P3-01 | `server/protocol.js` | Invert the P3-01 tests to expect 400 |
| 2 | Exclusive PID lock for the local store; friendly "already running" message | F07 | `server/store.js`, `server/index.js` | Invert the F07 process test: the second process refuses to start |
| 3 | Distinct response for a well-formed but unknown session cookie, instead of silently minting a wallet | P3-02 (F05/F09 aspect) | both adapters, `public/app.js` | Invert the lost-session test |
| 4 | Session lifecycle timestamps and server-side expiry (new sessions only; legacy rows treated as unknown age) | F09 (part) | `server/game.js` (session object only), adapters | New expiry tests; cleanup never removes active rounds |
| 5 | Math-version pinning | F11 | engine, verifier, proof schema `cargo-v2` | Invert the three F11 tests |
| 6 | Normalised storage and retention | F03 root, F09 retention | schema, migrations, both adapters | S15 unlimited; `storage.json` cost flat |

Items 5 and 6 change the settlement data path and ledger persistence and need explicit approval even though no amount would change.

## 6. Deferred financial or economic decisions

- **F01:** demo versus real-money funding; the fate of `/api/reset` and starting credit.
- **F02:** the external wallet protocol, rollback and reconciliation (needs the Saycove specification).
- **F04:** the maximum exposure and win limits.
- **F05:** automatic closure of final-port voyages and an abandonment or void policy.
- **F06:** the RTP target, including whether 96.8% is nominal or a best-play ceiling.
- **F11 policy:** which math version new rounds use, and the migration policy for tables.
- **Refill semantics:** whether a refill may lower a balance, and whether 0¢ entries are written.

## 7. Remaining risks

- All seven HIGH findings that are still open (F01, F02, F03 root, F04, F05, F07, F11) stand. **Not ready for real-money integration.**
- F11 is more dangerous than previously stated: a careless table edit can make sessions unreadable and invalidate exported proofs.
- **Untested:**
  - power-loss durability (no `fsync`);
  - real Cloudflare D1 behaviour (latency, replication, the real row limit);
  - gateway rate limits;
  - Safari and Firefox.
- **Timing-dependent tests:** the restart tests depend on where SIGKILL lands. Their assertions hold for any timing, but the exact path exercised varies between runs.
- **Wallet lockout:** sessions above the Phase 2 storage threshold remain locked out of new voyages until F03 is fixed.

## 8. Recommended next steps

1. **Approve** the non-financial technical corrections 1–4 (§5) as a Phase 4 implementation, each driven by its existing characterisation test.
2. **Decide** F11 pinning (item 5). It is the prerequisite for any payout-table work, including a 96.8% analysis.
3. **Design** the F03/F09 storage normalisation with a migration plan; review it against the D1 batch and row limits.
4. **Obtain** the Saycove specification before F01/F02 work.
5. **Deploy** later via the Sites workflow in `AGENTS.md`, only after approval.

## 9. Files added or changed in this phase

**Production:** none.

**Audit tooling and docs:**
- New: `CARGO_PHASE3_RELIABILITY_REPORT.md`, `audit/tests/reliability.test.js` (25 tests), `audit/tests/restart.test.js` (4 tests), `audit/measure-storage.mjs`, `audit/results/storage.json`.
- Updated:
  - `audit/lib/harness.mjs`: read/insert fault points; swappable Worker build.
  - `audit/lib/engine-variant.mjs`: also loads the verifier and Worker.
  - `audit/run-all.mjs`: storage step.
  - `audit/README.md`.
  - `audit/results/*.json`, regenerated by the full run.
