# Cargo phase 4A remediation report

**Date:** 7 October 2026
**Branch:** `claude/cargo-phase4a-reliability-fixes`. Local commit only; not pushed, merged or deployed.

> **Correction notice (Phase 4A.1, 8 October 2026, branch `claude/cargo-phase4a1-corrections`).** An independent review of
> this phase found that the F07 claims below were broader than the evidence supported. The text is kept as originally
> written for the record; the corrections are marked **[4A.1]** inline. In summary:
> - **R1** A live owner's lock could be taken by a server in another PID namespace (e.g. a second container on the same
>   host, both PID 1), because "own PID with an unknown token" was treated as proof that the owner had gone.
> - **R2** Concurrent stale-lock recovery could produce two owners: the rename-aside/restore step could move a newly
>   created lock away. The 6-process race test passed only because owners held for 800 ms; coverage showed the restore
>   branch never ran. A barrier-synchronized 3-process race reproduced two owners in 1 of 15 rounds.
> - **R3** A worker thread in the same process could take the lock (the "held tokens" set was per isolate).
> - **R4** A server that lost ownership kept serving its in-memory balances and voyages (stale reads); only writes were fenced.
> - **P3-02 edge cases R6–R8:** a failed read after a successful start left no working control, a focus change during a
>   pending start rebuilt the dialog and re-enabled its button, and closing the dialog left no way to reopen it.
>
> F07 was therefore **not FIXED** as stated here. See `CARGO_PHASE4A1_CORRECTION_REPORT.md` for the reproductions,
> the corrected design and its tested scope.

## 1. Executive summary

Phase 4A fixes three reliability defects identified in Phase 3. Each fix is backed by tests that failed on the base commit and pass now.

| ID | Defect | Status |
| --- | --- | --- |
| **F07** | Two local server processes on one save folder silently erased each other's data | **FIXED** on a single machine. Windows and power-loss behaviour are **UNVERIFIED** (§7) — **[4A.1] overstated: R1–R4 above; corrected status in the 4A.1 report** |
| **P3-02** | A missing session was silently replaced by a new funded wallet | **FIXED** (both adapters plus browser client) |
| **P3-01** | Deeply nested JSON returned 500 instead of 400 | **FIXED** (both adapters) |

One further defect was **introduced and fixed during this phase, before any commit**. An un-awaited promise in the new Worker session path let a storage failure escape the JSON error handler. It was caught by an existing Phase 3 fault test and now has its own regression test (§3.4).

**Not changed:** payout tables, the settlement engine, the RNG, the proof verifier and the collision mapping. They are byte-identical to the base commit, and an RNG stream replay matches.

**Out of scope as instructed:** F11, the F03 storage redesign and F09 expiry remain **DEFERRED**.

## 2. Baseline

| Item | Value |
| --- | --- |
| Base branch / commit | `claude/cargo-phase3-reliability-review` @ `fca90c6b0da2ecabe3339db81c00fc3145dfbdcd` (identical on GitHub) |
| Baseline run | `node audit/run-all.mjs --quick`: 13/13 maths, 8/8 RNG, 21/21 system, **75/75** regression, browser 2/2, `npm test` 12/12, hosted and collision pass, 0 unexpected changes |
| Matches Phase 3 report | **Yes, no discrepancy.** The committed `audit/results/` were restored after the quick run so the partial run did not replace full evidence |
| Red baseline | The new `audit/tests/phase4a.test.js` was run against the unmodified code, with only a constant stub added and then removed: **15 of 16 failed**. The one pass is the fingerprint-compatibility guard, which must pass before and after |

## 3. Root causes and exact changes

### 3.1 F07: local store ownership (FIXED — [4A.1] overstated, see correction notice)

- **Root cause.** `Store` loaded `state.json` once at construction and later overwrote the whole file from its in-memory copy, with no lock and no detection of another writer. Phase 3 showed a second process erasing an acknowledged wager.
- **Changes.**
  - **`server/lock.js` (new): exclusive ownership of a save folder through `state.lock`**, which holds `{ pid, hostname, token, startedAt }`.
    - *Atomic creation:* the lock is written in full to a temporary file, then hard-linked into place, so it never exists half-written and never overwrites. On file systems without hard links it falls back to an exclusive create (`wx`), with a 10-second grace period for a half-written file.
    - *Stale recovery only when the owner is provably gone:* a dead PID on this host; this process's own PID with a token it does not hold (an earlier incarnation, e.g. PID 1 after a container restart); or an unreadable lock older than 10 s.
    - *Refusals:* a live PID, a lock from another host, or a fresh unreadable lock are refused with a clear message that names the lock file and explains manual recovery.
    - *Recovery races:* the stale lock is renamed aside atomically (one winner), and a token check detects having moved a newer live lock, which is then restored without overwriting.
    - *Fencing:* `assertHeld()` re-reads the lock before every write and refuses if the token is no longer ours.
    - *Safe release:* `release()` deletes the lock only if it still carries our token.
  - **`server/store.js`:**
    - new `acquire()` and `release()`;
    - `acquire()` **reloads `state.json` after taking the lock**, so a Store constructed earlier cannot write a stale copy;
    - `transaction()` acquires on demand and runs the fencing check;
    - read-only use (constructor plus `get`) needs no lock, so the existing `test/api.test.js` reload check is unchanged;
    - the atomic temp-file-then-rename write is unchanged.
  - **`server/index.js`:**
    - acquires the lock at startup; if it is held, prints the message and exits with code 1;
    - releases it on `exit`;
    - `SIGINT`, `SIGTERM` and `SIGHUP` now exit through `process.exit(0)` so that the release runs.
- **Evidence:**
  - in-process second writer refused, and the next owner reloads (no lost update);
  - stale-lock recovery for each of the three stale conditions above;
  - refusal of a live owner, a remote host and a fresh unreadable lock, without deleting their lock files;
  - release never deletes a foreign lock;
  - a store that lost its lock refuses to write and leaves `state.json` byte-identical;
  - **six processes racing for one stale lock produce exactly one owner** (3 races per run, 5 stress runs: 15 of 15); **[4A.1] this test did not exercise contention (owners held for a fixed 800 ms; the restore branch never ran)**;
  - two real servers started simultaneously: exactly one runs, the other exits 1 with "already running … state.lock", and the runner's wager survives;
  - after SIGTERM or SIGINT the lock is removed; after SIGKILL the next start recovers automatically and the data is intact;
  - the Phase 3 restart and SIGKILL tests still pass.

### 3.2 P3-02: missing-session detection (FIXED)

- **Root cause.** Both adapters treated "cookie present but session unknown" the same as "no cookie". `GET /api/session` silently created a funded $1,000 wallet and replaced the cookie, masking lost data.
- **Changes:**
  - **`server/app.js` and `server/worker.js`:**
    - **Missing session:** a well-formed cookie with no stored session now gets **404 `SESSION_NOT_FOUND`** on every API route. No `Set-Cookie` is sent and nothing is created.
    - **New visitor:** a visitor without a cookie still gets a session on `GET /api/session`, as before.
    - **Explicit recovery:** new **`POST /api/session`** starts a new demo session. It goes through the existing same-origin and JSON content-type checks, and returns **409 `SESSION_EXISTS`** if the browser still has a live session.
  - **`public/app.js`:**
    - on `SESSION_NOT_FOUND`, shows a "Saved session not found" dialog: *"…Nothing has been changed and no new session has been created…"*, with **Start a new demo session** (the explicit POST) and **Try again**;
    - stops the 12-second polling;
    - shows the status line "Saved session not found · choose an option to continue";
    - replaces the static "$1,000.00" balance placeholder with "—", so no wallet is implied.
- **Evidence:**
  - on both adapters: GET, POST, round read and bet with an unknown cookie all return 404 `SESSION_NOT_FOUND`, the cookie is unchanged and the session count is unchanged;
  - the explicit start requires same origin (403 otherwise) and JSON (415 otherwise), and returns 409 with a live session, whose active round is untouched;
  - a session deleted mid-voyage is reported, not replaced, and other sessions keep working;
  - **real Chromium, desktop and 390 px phone** (§6): the dialog appears; no session is created on load, after 1.5 s, or after **Try again**; exactly one is created after **Start a new demo session**, with a new cookie and $1,000.00 shown; no horizontal overflow; no console problems apart from the expected 404 resource message.

### 3.3 P3-01: JSON nesting limit (FIXED)

- **Root cause.** Both adapters fingerprinted the parsed body with recursive functions (`canonicalJSON`, legacy `JSON.stringify`) before validating its shape. A body inside the 16 KB limit could nest about 8,160 levels and overflow the stack: from about 3,000 levels (Phase 2 canonicaliser) or about 4,200 (legacy). The result was HTTP 500.
- **Change.** In `server/protocol.js`, an **iterative** scanner counts structural depth (brackets outside strings, honouring backslash escapes) before `JSON.parse`. Anything deeper than `MAX_JSON_DEPTH = 32` returns **400 `JSON_TOO_DEEP`**. Real requests nest at most two levels. UTF-8 decoding, the 16 KB limit (checked first, still 413) and the canonical and legacy fingerprints are unchanged.
- **Evidence:**
  - depth 32 accepted; depth 33, 100, 3,011 and 8,100 refused, with no state change;
  - 5,000 `[` and `{` characters inside strings, escaped quotes and backslashes, a U+2028 character and bracket-named keys all parse correctly;
  - over the size limit still returns 413;
  - **three reference fingerprints captured before the change are byte-identical afterwards**, so idempotency receipts remain compatible;
  - Worker and local adapters behave identically, as does the built bundle.

### 3.4 Defect found and fixed during this phase (never committed)

The new Worker code returned `startSession()` without `await` inside its `try` block. A rejected D1 insert therefore bypassed the JSON error handler, and the request rejected instead of returning `{ code: "SERVER_ERROR" }` with status 500. The existing Phase 3 test "worker: read failure, session-insert failure…" failed on it. Fixed with `return await` at both call sites, and a new regression test covers the GET and `POST /api/session` insert-failure paths: 500 JSON, no cookie, nothing created, and the retry succeeds.

## 4. Tests added or modified

| File | Change |
| --- | --- |
| `audit/tests/phase4a.test.js` | **New, 17 tests:** P3-01 ×4 (unit, fingerprint pins, local, Worker); P3-02 ×7 (3 per adapter plus the Worker insert-failure regression); F07 ×6 (in-process, stale recovery and refusal, fencing and safe release, six-process race, simultaneous real servers, graceful/crash lifecycle). All child processes are registered and killed in an `after` hook; process tests have timeouts |
| `audit/tests/reliability.test.js` | KNOWN DEFECT P3-01 → **"P3-01 fixed"** (expects 400 `JSON_TOO_DEEP`). KNOWN DEFECT F05/F09 split into **"P3-02 fixed"** (404, no new wallet) and **KNOWN DEFECT F09** (no lifecycle timestamps; still open). The duplicate-cookie test now expects 404 `SESSION_NOT_FOUND` for the first cookie. Three local-restart tests now release the first Store's lock, as a real process exit would |
| `audit/tests/restart.test.js` | KNOWN DEFECT F07 → **"F07 fixed"**: the second process exits 1 with "already running"; the first process's wager is intact |
| `audit/tests/known-defects.test.js` | KNOWN DEFECT F07 (in-process) → **"F07 fixed"** |
| `audit/validate-system.mjs` | S17 is now type `remediated` (second writer refused, debit intact) |
| `audit/browser-check.mjs` | Two new scenarios: `desktop-missing-session` and `phone-missing-session` |
| `audit/lib/harness.mjs` | The local adapter releases its Store lock on close |
| `audit/run-all.mjs` | Allowlist updated with the authorised Phase 4A files. New guard: `public/math.js`, `public/fairness.js`, `server/game.js`, `server/fairness.js` and `public/collision.js` must be byte-identical to `fca90c6`. `server/store.js` moved from must-be-identical to intended changes |

## 5. Full verification results

| Command | Node 24.21.0 | Node 22.22.0 |
| --- | --- | --- |
| `PLAYWRIGHT_MODULE=… node audit/run-all.mjs` (full, with F03 capacity) | **ALL PASSED** | — |
| ↳ `validate-math.mjs` | 13/13 | — |
| ↳ `validate-claims.mjs` | 169 match / 69 consistent / 10 unverifiable / 2 known audit-text slips (unchanged) | — |
| ↳ `validate-rng.mjs` | 8/8; 108 known-answer vectors unchanged | — |
| ↳ `analyze-simulation.mjs` | Unchanged (0 Bonferroni rejections) | — |
| ↳ `validate-system.mjs` | 21/21: 12 safety, **4 remediated** (S13, S17, S18, S20), 1 mitigated, 3 open defects reproduce (S14, S16, S19), 1 observation | — |
| ↳ `measure-storage.mjs` | Ran (about 2.18 KB per round; unchanged behaviour) | — |
| ↳ `node --test audit/tests/*.test.js` | **94/94** | **94/94** |
| ↳ `browser-check.mjs` (Chromium 141) | **4/4**: desktop, phone, desktop-missing-session, phone-missing-session | — |
| ↳ `npm test` | 12/12 | 12/12 |
| ↳ `npm run test:hosted` | Pass | Pass |
| ↳ `npm run test:collisions` | Pass | Pass |
| ↳ Production integrity | 13 intended changes since `25d5181`, **0 unexpected, 0 protected, 0 payout/settlement/RNG changes since `fca90c6`** | — |
| `npm run build` + built-bundle smoke test | Pass: missing → 404 `SESSION_NOT_FOUND` (no cookie); explicit start → 200 with cookie; live session → 409; depth 5,000 → 400 `JSON_TOO_DEEP` | — |
| `git diff fca90c6 -- public/math.js public/fairness.js server/game.js server/fairness.js public/collision.js` | **Empty** | — |
| RNG stream replay (`simulate.mjs --rounds 50000`, 600,000 decks) | **Identical** chunk hashes for all four modes | — |
| F07 stress: `phase4a.test.js --test-name-pattern=F07` ×5 | 5/5 runs pass (15 six-process races, one owner each); no stray processes | — |

**Explicit confirmations:**
- RNG output unchanged (known-answer vectors and stream replay).
- Payout tables unchanged (ladder fingerprint test; empty diff).
- Settlement logic unchanged (`server/game.js` byte-identical; the S10 settlement campaign passes).
- Phase 2 protections still pass (`remediation.test.js` 15/15; S13, S18, S20).
- Session and ledger integrity intact (state-machine fuzz, reliability and SIGKILL suites).

## 6. Remaining limitations (status labels)

| Item | Status | Detail |
| --- | --- | --- |
| Windows behaviour of the lock | **UNVERIFIED** | Uses only cross-platform Node APIs (`fs.linkSync` on NTFS, `wx` fallback, `process.kill(pid, 0)`), and Windows emulates `SIGHUP` when a console window closes. No Windows run was possible here |
| Power-loss durability | **UNVERIFIED** | No `fsync` of `state.json` or its directory. Only process crashes (SIGKILL) were tested |
| Shared or network folders | **MITIGATED** | A lock from another host is refused, never recovered automatically. NFS/SMB link and rename semantics were not tested |
| PID reuse | **MITIGATED** | If a crashed owner's PID is reused by an unrelated live process, startup refuses (fail-safe) with instructions to delete `state.lock`. Own-PID reuse (containers) is recovered automatically — **[4A.1] this own-PID rule was unsafe (R1): it also took live locks across PID namespaces and from worker threads** |
| Fencing window | **MITIGATED** | The ownership check runs immediately before each write; a takeover in the microseconds between check and rename is not prevented. Takeover only happens when the owner's PID is dead — **[4A.1] not true: R1–R3 allowed takeover of a live owner, and reads were not fenced (R4)** |
| Client cache | **MITIGATED** | A browser still running the pre-4A `app.js` would show "Could not connect" (no wallet is created) until reloaded. The local server sends `Cache-Control: no-cache`; hosted asset caching was not inspected |
| F11, F03 root, F09 expiry | **DEFERRED** | Out of scope by instruction; characterisation tests still reproduce them |
| F01, F02, F04, F05 closure, F06 | **DEFERRED** | Financial or economic decisions |
| Live private site | **UNVERIFIED / not deployed** | No deployment was performed |

## 7. Compatibility and regression risks

1. **API contract.**
   - A well-formed cookie for a missing session now gets 404 `SESSION_NOT_FOUND` instead of a new wallet (GET) or 401 `SESSION_EXPIRED` (POST).
   - New `POST /api/session` endpoint.
   - JSON deeper than 32 levels → 400. Previously such requests were processed up to about 3,000 levels.
   - All are documented in `docs/API.md`. The bundled client handles them. No other clients are known.
2. **Local server operations.**
   - A `state.lock` file appears in the save folder while running.
   - A second server on the same folder exits with code 1.
   - Ctrl+C now exits with code 0 (previously the signal default).
   - `README.md` documents this, including manual removal of a stale lock.
3. **Embedding the Store.** Code that opens two writing `Store` objects on one folder in one process now gets `DATA_DIRECTORY_LOCKED`. Read-only use is unaffected. The audit harness was updated accordingly.
4. **Performance.** One small lock-file read per write (local store only).
5. **Hosted adapter.** Behaviour is unchanged except for P3-01 and P3-02. The F07 lock applies only to the local file store.

## 8. Files changed (relative to `fca90c6`)

**Production (authorised scope):**
- `server/lock.js` (new)
- `server/store.js`
- `server/index.js`
- `server/app.js`
- `server/worker.js`
- `server/protocol.js`
- `public/app.js`

**Documentation:**
- `README.md`
- `docs/API.md`
- `docs/INTEGRATION.md`
- `CARGO_PHASE4A_REMEDIATION_REPORT.md` (new)

**Audit tooling and tests:**
- `audit/tests/phase4a.test.js` (new)
- `audit/tests/reliability.test.js`
- `audit/tests/restart.test.js`
- `audit/tests/known-defects.test.js`
- `audit/validate-system.mjs`
- `audit/browser-check.mjs`
- `audit/lib/harness.mjs`
- `audit/run-all.mjs`
- regenerated `audit/results/*.json`

**Unchanged:**
- **payout, settlement and RNG:** `public/math.js`, `server/game.js`, `server/fairness.js`;
- **verifier and collision mapping:** `public/fairness.js`, `public/collision.js`;
- **storage schema and migrations:** `db/`, `drizzle/`;
- **build and hosting:** `build/`, `package*.json`, `.openai/hosting.json`;
- **existing tests:** `test/`.

## 9. Recommended next milestone

1. **Technical lead review** of this branch, especially `server/lock.js` (stale recovery and fencing) and the `SESSION_NOT_FOUND` / `POST /api/session` contract.
2. **Windows verification** of the lock and graceful shutdown (`START-CARGO.cmd`, Ctrl+C, closing the console window).
3. **Phase 4B design reviews** (no implementation yet):
   - F11 math-version pinning (prerequisite for any payout-table work);
   - F09 session lifecycle and expiry;
   - F03 storage normalisation.
4. **Optional hardening:** `fsync` of `state.json` and its directory, with an independent power-loss test.
5. **Deployment** of Phases 2–4A to the private site via the Sites workflow in `AGENTS.md`, only after approval.
