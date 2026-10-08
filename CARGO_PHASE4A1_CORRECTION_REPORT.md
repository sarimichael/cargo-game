# Cargo phase 4A.1 correction report

**Date:** 8 October 2026
**Branch:** `claude/cargo-phase4a1-corrections`, created from `a786d9958440b2245e237b7b90c00c58e6ca17a6` (`claude/cargo-phase4a-reliability-fixes`).
**Status:** local commit only. Not pushed, merged or deployed, and no pull request. `main` and all earlier branches are unchanged.

> **Correction notice (Phase 4A.2, 8 October 2026, branch `claude/cargo-phase4a2-browser-reliability`).** The statements about
> retrying a start were stronger than the code. The Phase 4A.1 browser did **not** require a read before a second start:
> after a start failed without an answer, the rebuilt dialog re-enabled **Start a new demo session** at once, and the
> reproduction in CARGO_PHASE4A2_CORRECTION_REPORT.md sends a second `POST /api/session` with no read in between. The
> original text is kept; the affected sentences are marked **[4A.2]**. Phase 4A.2 adds a client-side safeguard (a read must
> complete before another start); that is still not idempotency, and R5 remains deferred.

## 1. Executive summary

Phase 4A.1 corrects the defects that the independent review found in Phase 4A. The main mission was exclusive ownership of the local demo server's save folder (F07, review findings R1–R4). The secondary work covered browser session recovery (P3-02 edge cases R6–R8) and the retry behaviour of `POST /api/session` (R5).

| ID | Finding | Phase 4A.1 status |
| --- | --- | --- |
| **F07** | Exclusive ownership of the local save folder | **FIXED within the tested conditions:** one Linux machine, a local file system (ext4), separate processes, worker threads and PID namespaces on one kernel, Node 22 and Node 24. **UNVERIFIED** on Windows and macOS (§7). Network, shared and cloud-synced folders are **not supported**: Cargo refuses a second server there but never recovers automatically. |
| R1 | A live lock was taken across PID namespaces, or by trusting PID equality | **FIXED.** Liveness is now proven by a socket held open by the owner. A PID is never sufficient evidence, and a lock carrying this process's own PID is never taken. |
| R2 | Concurrent stale-lock recovery could produce two owners | **FIXED.** Recovery is serialized by an exclusive `state.lock.recover`, is re-confirmed under it, and never removes a lock it did not confirm dead. Tested with 3- and 12-way barrier races and 80 stress rounds. |
| R3 | A worker thread could take its own process's lock | **FIXED.** Ownership no longer depends on per-isolate memory. |
| R4 | A fenced-out server kept serving stale balances | **FIXED.** Every read and write is fenced. A server that loses ownership returns 503 `SERVER_UNAVAILABLE` with no state, then exits. |
| R5 | `POST /api/session` is not idempotent | **DEFERRED, with a proposal for separate approval (§5).** The client now re-reads before any second start. **[4A.2] Inaccurate: the 4A.1 client only advised a re-read; the Start button was re-enabled immediately. Phase 4A.2 enforces a completed read in the same tab, which is still not idempotency.** |
| R6–R8 | Browser recovery edge cases | **FIXED** in `public/app.js`, verified in real Chromium on desktop and phone. |
| R9 | Deep Phase 4A receipts are not replayable | **Unchanged (INFO).** P3-01 is preserved as instructed. A bounded property test was added. |

**Not changed:** payout tables, the settlement engine, the RNG, the proof verifier, wallet accounting, the collision mapping, the database schema and the hosting manifest. They are byte-identical to the Phase 4A base, and `run-all` enforces this (§6).

## 2. Starting checkpoint and red baseline

| Item | Value |
| --- | --- |
| Base | `a786d9958440b2245e237b7b90c00c58e6ca17a6`, clean tree |
| Baseline run | `node audit/run-all.mjs --quick` (Node 24.21.0): 13/13 maths, 8/8 RNG, 21/21 system, **94/94** regression, browser 4/4, `npm test` 12/12, hosted and collision pass, 0 unexpected or protected changes. This matches the Phase 4A report. Committed evidence was restored afterwards with `git checkout -- audit/results`. |
| Red baseline: new lock tests | `audit/tests/phase4a1.test.js` run against the unmodified Phase 4A code: **11 of 16 failed** (`audit/results/phase4a1-red-baseline.txt`). The 3-process barrier race produced **two owners in 1 of 15 rounds**, with a live owner losing its lock. The worker thread acquired the lock. A namespaced second server started on a live owner's folder. A fenced-out server answered 200 with its stale balance. |
| Red baseline: stress | `audit/stress-lock.mjs` against Phase 4A, same harness: **2 of 20** crash-recovery rounds with 3 contenders and **1 of 20** with 12 contenders produced two owners (`audit/results/lock-stress-phase4a-base-{3,12}.json`). |
| Red baseline: browser | The new recovery edge-case scenario with the Phase 4A client stops at R8: after closing the dialog there is no control to reopen it. |

Five tests passed on the base, as expected:
- three safety properties Phase 4A already met: a live unrelated PID is refused, the post-SIGKILL restart works, and release keeps a foreign lock;
- the 12-way race, which did not hit the window in its 6 rounds;
- the P3-01 property test, which guards existing behaviour.

## 3. Root causes

| Finding | Root cause in Phase 4A |
| --- | --- |
| R1 | Liveness was inferred from `hostname` + `process.kill(pid, 0)`. PIDs are not unique across PID namespaces: two containers can both be PID 1 on one kernel. The own-PID rule (`pid === process.pid` and the token is not held, therefore stale) declared any such lock dead, including a live owner in another namespace. |
| R2 | Recovery renamed the stale lock aside, compared tokens, and on a mismatch tried to put back what it had moved. Between one contender's read and its rename, another contender could already have recovered and created a fresh lock. The rename then moved that live lock aside, the restore could fail or race, and a third process could create its own lock. The result was two processes, each believing it held the folder. The 800 ms holding period in the old test hid this. |
| R3 | `heldTokens` lived in module memory, which is per isolate. A worker thread saw its own process's PID and an unknown token, so the own-PID rule declared the lock stale. |
| R4 | `assertHeld()` ran only before writes. `get()` served the in-memory copy without checking ownership, and nothing stopped the server after a loss. |
| Shared temporary file | Every owner wrote through the same `state.json.tmp`. With two owners (R1–R3), one could rename the other's half-written file into place. |
| R6 | After a successful `POST`, a failed follow-up `GET` was routed to the generic offline state. The dialog had already closed, and its only control had been consumed. |
| R7 | The `visibilitychange` handler called `sync()` unconditionally. During a pending start, the `SESSION_NOT_FOUND` it received rebuilt the dialog with fresh, enabled buttons. |
| R8 | Closing the dialog left a status line with text but no control. |

## 4. Corrections

### 4.1 F07: save-folder ownership (`server/lock.js`, `server/store.js`, `server/index.js`, `server/app.js`)

**Liveness is proven, never inferred.**
- The owner listens on a Unix domain socket next to the lock: `state.lock.<token12>.sock`. On Windows it is a named pipe, and when the folder path is too long for a socket name the socket goes in the temp directory.
- The kernel accepts connections to a listening socket even while the owner's event loop is busy. Once the owning process has gone, it refuses them (`ECONNREFUSED`).
- This gives direct evidence that works across PID namespaces and containers on one kernel, with no heartbeat or timeout.
- A refusal must be seen twice, 50 ms apart, before it counts.
- The endpoint path is derived from the folder and the token, never read from the lock file.

**Lock format v2.** The lock is `{version, pid, hostname, bootId, pidNs, token, endpoint, startedAt}`, created atomically with a hard link (falling back to exclusive create).

**Owner status** is `live`, `dead` or `unknown`. Only `dead` permits recovery.

`dead` requires one of the following:
- the endpoint refuses connections twice, on the same kernel (same `boot_id`);
- the same hostname, a different `boot_id` and a local file system, meaning the machine has restarted since the lock was taken;
- no endpoint file **and** the same PID namespace **and** a PID that is not this process **and** `ESRCH`.

Everything else is `unknown` and refuses startup:
- unreadable, truncated or Phase 4A-format locks, at any age;
- another machine;
- a shared or network file system (detected with `statfs` on Linux);
- a probe timeout or any other error;
- this process's own PID;
- a live PID with no endpoint.

**Serialized recovery.** A contender that finds a dead owner must create `state.lock.recover` exclusively. Under it, the contender:
1. re-reads the lock and requires the same token;
2. re-confirms `dead`;
3. moves the lock aside, verifies it moved exactly that lock, and puts back anything else without overwriting;
4. removes the dead owner's socket;
5. creates its own lock while still holding the mutex.

A losing contender is refused. A newcomer that creates a lock in the gap simply wins, and the recoverer's create fails. If a recovery is interrupted, `state.lock.recover` blocks automatic recovery until it is deleted deliberately; the message names the file.

**Fencing and lost ownership.**
- `Store.get()` and `Store.transaction()` call `ensureOwned()`. This checks that the lock still carries the store's token and that the store's socket file is still the inode it bound.
- The check runs before every read and write, and again just before the rename.
- On loss, the store drops its in-memory copy, refuses all further reads and writes (`OWNERSHIP_LOST`), and calls `onLost`.
- `server/app.js` maps the loss to **503 `SERVER_UNAVAILABLE`** with no state in the body.
- `server/index.js` logs the reason, stops accepting connections and exits with status 1.
- A 1-second watcher also notices a loss between requests.
- Release removes the lock only if it still carries the store's token; the lock is moved aside and checked before deletion.

**Startup and errors.**
- `index.js` awaits `store.acquire()`, which resolves only once the server is listening on its endpoint.
- Failures are either `DATA_DIRECTORY_LOCKED` (another owner, or uncertain) or `DATA_DIRECTORY_UNAVAILABLE` (the folder cannot be used). Both print a message and exit 1.
- A lazy, synchronous, create-only path is kept for `Store.transaction()` without `acquire()`, which tests and harnesses use. It never recovers.

**Temporary files.** Each owner writes through `state.json.<token12>.tmp`. Leftovers from interrupted earlier owners are removed after the lock is acquired.

### 4.2 P3-02 browser edge cases (`public/app.js`)

The recovery state is explicit: `missing`, `starting` or `unloaded`.

| Finding | Correction |
| --- | --- |
| R7 | While a start is pending, `sessionNotFound()` never rebuilds the dialog, and its buttons stay disabled. `visibilitychange` and the 12 s poll skip `sync()` while any recovery state is active. |
| R6 | After a successful start, a failed read moves to **"New demo session started"** with **Load my new session**. That button only re-reads and never starts another session. |
| R8 | Closing the dialog (×, Escape or backdrop) leaves a status-line button: **Choose an option** or **Load it**. It reopens the right dialog. A focus change does not reopen it. |
| Missing vs network | A network failure during **Try again** shows "Could not reach the game server, so your saved session was not checked". The session is not reported as missing again. A failed start says the outcome is unknown and asks the player to re-check first. |
| No auto-creation | Unchanged: only an explicit click creates a session. Verified by counting sessions on disk. |

### 4.3 Documentation

- **README:** the lock files, confirmed-termination recovery, manual recovery, the local-disk-only requirement and the not-distributed scope.
- **`docs/API.md`:** 503 `SERVER_UNAVAILABLE`, and the non-idempotent `POST /api/session`, with a pointer to R5.
- **`docs/INTEGRATION.md`:** the supported operating conditions.
- **`CARGO_PHASE4A_REMEDIATION_REPORT.md`:** a correction notice, plus inline **[4A.1]** markers on the overstated F07 claims. The original text is preserved.

## 5. R5: making retries of the same explicit start safe (proposal, not implemented)

**Current limitation.** A retry of `POST /api/session` creates another funded play-money session in two cases:
- the first response was lost after the server committed, for example by a timeout or a dropped connection;
- two tabs both click **Start**.

The extra session is unused, and the browser keeps whichever cookie it received last. No money is involved, but the same pattern would duplicate funding in a real-wallet integration.

**Mitigation in 4A.1.**
- After a failed start, the dialog tells the player that the outcome is unknown and to choose **Try again**. That only re-reads, and finds the new session if its cookie arrived. **[4A.2] The same dialog also re-enabled Start, so a second start without any read was possible.**
- Buttons stay disabled while a start is pending.
- Nothing is created automatically.

**Proposed mechanism.**
1. **The client generates a `recoveryId`** (UUID) once per missing-session episode. It stores it in `localStorage` so all tabs share it, falls back to memory if storage fails, and sends it as `POST /api/session {recoveryId}`.
2. **The server requires the old session cookie** (HttpOnly, so only this browser has it). It keys the attempt by `sha256(oldSessionId + ':' + recoveryId)`.
   - In the same transaction that creates the new session, it records `{key → newSessionId, createdAt}`. The local store does this in `state.json`. The Worker needs a new table with a primary-key or unique constraint and an `INSERT … ON CONFLICT DO NOTHING` in the same batch, then a read-back.
3. **A retry with the same old cookie and `recoveryId`** returns the same new session and re-sends its `Set-Cookie`. A retry that already carries the new cookie gets `SESSION_EXISTS`, which the client already treats as success.
4. **Records expire** after about 10 minutes.

**Security.**
- A `recoveryId` alone must never act as a bearer credential. Replay requires the old HttpOnly cookie as well, so the new session's cookie is only ever revealed to the browser that asked for it.
- The old session ID no longer grants access to anything else.
- Guessing a `recoveryId` (122 bits) is infeasible.

**Limits.**
- If both storage and memory are lost (a reload with storage blocked), a new episode gets a new `recoveryId`. That allows at most one extra session per reload.

**Why deferred.** The Worker path needs a schema change, and `db/schema.ts` is a protected file. The change also alters the API contract. Both need separate approval.

## 6. Tests and verification

### 6.1 New and changed tests

| File | Change |
| --- | --- |
| `audit/tests/phase4a1.test.js` | **New, 16 tests**, listed below |
| `audit/fixtures/lock-contender.mjs`, `lock-crash.mjs` | **New.** A barrier-synchronized contender that holds until a signal file appears and checks its lock every 5 ms; and an owner that is SIGKILLed to leave a genuine stale lock |
| `audit/stress-lock.mjs` | **New.** Crash-recovery and live-owner races, alternating, with N contenders. Run by `run-all` (12 rounds, full mode) and standalone (40 rounds) |
| `audit/tests/phase4a.test.js` | Three F07 tests encoded Phase 4A semantics: own-PID recovery, recovery of an old unreadable lock, and the 800 ms race. They are replaced by a corrected-semantics test, and the history is noted in a comment. The fencing test now expects `OWNERSHIP_LOST` |
| `audit/validate-system.mjs` | S12's fault injection matches the per-owner temporary file name |
| `audit/browser-check.mjs` | **New desktop and phone scenario:** close, focus, reopen, network failure on retry, focus during a pending start, failed follow-up read, close and reopen, load. It counts sessions on disk and POST and GET requests |
| `audit/run-all.mjs` | Adds the lock stress step in full mode. The integrity lists are unchanged: every file 4A.1 touches was already an intended change |

The 16 tests in `audit/tests/phase4a1.test.js`:
- R2: barrier-synchronized crash recovery with 3 contenders (15 rounds) and with 12 contenders (6 rounds);
- R2: a live owner against 12 simultaneous starters;
- R3: a worker thread, both before and after the owner is listening;
- R1: own PID with an unknown token, a reused PID, a namespaced second server against a live owner, and recovery of an owner that crashed inside a namespace;
- termination: SIGKILL, then automatic recovery with the data intact and no lock files left over;
- release that cannot delete a foreign lock;
- fail closed: an unreadable lock at any age, and an interrupted recovery;
- R4: over HTTP, both a replaced lock and a removed socket give 503, no stale read, exit status 1, and `state.json` unchanged with the acknowledged bet intact;
- R4: an in-process Store;
- the per-owner temporary file;
- a bounded P3-01 property test (1,500 documents and 1,500 malformed inputs).

### 6.2 Verification results

All runs were on Linux x64, ext4, as root, with Chromium 141 via Playwright.

| Check | Command | Node 24.21.0 | Node 22.22.0 |
| --- | --- | --- | --- |
| Full suite | `PLAYWRIGHT_MODULE=… node audit/run-all.mjs` (full mode, no re-simulation) | **ALL PASSED** (`audit/results/manifest.json`) | `--quick`: every step passed except one test (see note below); fixed and re-run |
| Exact maths / claims / RNG | part of `run-all` | 13/13, unchanged, 8/8 (108 known-answer vectors) | 13/13, unchanged, 8/8 |
| System / adversarial | `audit/validate-system.mjs` | 21/21 | 21/21 |
| Regression tests | `node --test audit/tests/*.test.js` | **109/109**, ×4 runs (one in `run-all`, three standalone) | **109/109**, ×3 runs |
| Real browser, desktop + 390 px phone | `audit/browser-check.mjs` | 6/6 scenarios | 6/6 scenarios |
| Existing tests | `npm test`, `npm run test:hosted`, `npm run test:collisions` | 12/12, pass, pass | 12/12, pass, pass |
| Lock stress | `audit/stress-lock.mjs --rounds 40 --contenders 12` | **PASS**: 20/20 crash-recovery rounds with exactly one owner; 0 lost while held; 20/20 live-owner rounds with all 12 refused; 0 errors; no debris | **PASS**, same numbers |
| Lock stress (in `run-all`) | `--rounds 12` | PASS, 6 + 6 rounds | — |
| Phase 4A base, same harness | `stress-lock.mjs` in a worktree at `a786d99` | **FAIL**: two owners in 2/20 rounds (3 contenders) and 1/20 rounds (12 contenders) | — |
| PID namespaces | `unshare --pid --fork --mount-proc` tests, ×5 per version after the fix below | pass | pass |
| Hosted release | `npm ci && npm run build` | Build OK. `dist/client/app.js` is identical to `public/app.js`; the Worker bundle loads, exports `fetch` and contains no lock code | — |
| Integrity | `run-all` production-integrity check | 0 unexpected changes, 0 protected files changed, 0 changes to payout, settlement, RNG, proof or collision files since `fca90c6`. `server/protocol.js`, `server/worker.js`, `db/schema.ts` and `package*.json` are unchanged from `a786d99` | — |
| Secrets and scope | diff scan for keys and tokens; `git status` | No credentials, `data/`, `.env` or seeds. `dist/` and `node_modules/` are ignored | — |

**Note (Node 22, first run).** The namespace-crash recovery test failed once. Its own precondition was too weak: it waited only for the killed PID-1 process to become a zombie, and the kernel was still tearing down that process's socket. The lock therefore correctly answered "live" and refused, which is the safe direction. The test now waits until the process no longer exists. It then passed 5/5 on each Node version and in all later full runs. No product code changed for this.

**Safety properties verified:**
- **No double ownership:** 0 in 40 + 40 stress rounds plus 21 test races. Phase 4A produced 3 in the same harness.
- **No acknowledged data lost:** SIGKILL recovery and ownership-loss tests compare `state.json` byte for byte.
- **No stale reads:** a fenced-out server returns 503 with no state.
- **No recovery regressions:** crash recovery works for normal processes and for owners inside PID namespaces.
- **No changes to maths, RNG, proof or settlement:** confirmed by the integrity check and the unchanged RNG vectors.

## 7. Remaining risks and platform limits

| Item | Status | Detail |
| --- | --- | --- |
| Windows lock behaviour | **UNVERIFIED** | Named-pipe endpoint. A missing pipe falls back to the PID check, which refuses whenever the PID is alive, so a reused PID needs manual recovery. No Windows run was possible |
| macOS lock behaviour | **UNVERIFIED** | No `boot_id`, so the same machine is identified by hostname. BSD kernels can refuse connections when a socket's listen backlog is full; the double probe reduces this risk but it was not measured |
| Network, cloud-synced or multi-host folders | **NOT SUPPORTED (fail-closed)** | Detected on Linux via `statfs` (NFS, SMB/CIFS, FUSE including virtiofs and sync clients, 9p, Ceph, and others). A second server is refused, recovery is never automatic, and this is documented. On other operating systems the file-system type is not checked. Hard-link atomicity on network file systems was not tested |
| Containers on one host sharing a bind-mounted folder | **Tested only with PID namespaces** (`unshare`). The socket works across mount namespaces on one kernel, but Docker and Kubernetes were not run. Docker Desktop on macOS or Windows uses a VM file share, which is refused rather than recovered |
| Crash between creating the lock and listening (lazy path only) | **MITIGATED** | Recovered via `ESRCH` in the same PID namespace. Otherwise refused, and manual recovery is needed |
| Interrupted recovery | **Fail-closed by design** | `state.lock.recover` must be deleted manually. The window is a few milliseconds |
| Fencing window | **MITIGATED** | The check runs immediately before the rename. A live owner can no longer be taken over automatically, so only manual deletion of a live owner's lock could open this window |
| Manual misuse | **Out of scope** | Deleting `state.lock` or its socket while a server runs makes that server stop (R4). A second server could then start, but no acknowledged data is lost |
| Power-loss durability | **UNVERIFIED** (unchanged) | No `fsync` |
| R5 duplicate sessions | **DEFERRED** | §5 |
| R9 deep legacy receipts | **INFO** (unchanged) | Within the accepted P3-01 contract |
| Live private site | **Not deployed** | No deployment was performed |

## 8. Files changed (relative to `a786d99`)

| File | Change |
| --- | --- |
| `server/lock.js` | Rewritten: socket-proven liveness, v2 lock, owner status (`live`, `dead`, `unknown`), recovery mutex, fail-closed rules, shared file-system detection, fenced `assertHeld`, token-checked release |
| `server/store.js` | Async `acquire()`, lazy create-only path, `ensureOwned()` on reads and writes, `onLost` and `watch()`, per-owner temporary file and cleanup |
| `server/index.js` | Awaits acquisition, handles `DATA_DIRECTORY_UNAVAILABLE`, exits on ownership loss, starts a 1 s ownership watcher |
| `server/app.js` | `OWNERSHIP_LOST` mapped to 503 `SERVER_UNAVAILABLE` |
| `public/app.js` | Explicit recovery state; R6–R8 corrections |
| `README.md`, `docs/API.md`, `docs/INTEGRATION.md` | Supported conditions, 503, R5 limitation |
| `CARGO_PHASE4A_REMEDIATION_REPORT.md` | Correction notice and inline [4A.1] markers |
| `CARGO_PHASE4A1_CORRECTION_REPORT.md` | This report |
| `audit/tests/phase4a1.test.js`, `audit/fixtures/lock-*.mjs`, `audit/stress-lock.mjs` | New tests, fixtures and stress harness |
| `audit/tests/phase4a.test.js`, `audit/validate-system.mjs`, `audit/browser-check.mjs`, `audit/run-all.mjs` | Updated as described in §6.1 |
| `audit/results/*` | Regenerated by the full Node 24 run, plus new evidence: `phase4a1-red-baseline.txt`, `lock-stress*.json` (Node 22, Node 24, Phase 4A base). The changes to `claims.json` and `simulation.json` are timestamps only |

## 9. Integration recommendation

**GO for technical lead review. Do not merge before that review.**

Within the tested conditions, the corrections close R1–R4 and R6–R8. The barrier-synchronized tests and stress runs measure the safety properties directly: one owner per round, no owner losing a lock it held, no stale reads and no lost acknowledged data. The same harness reproduces the Phase 4A failures on the base.

Suggested order:
1. Review `server/lock.js`: the owner-status rules and the recovery mutex.
2. Review the 503 shutdown contract.
3. Decide on the R5 proposal.
4. Run the new tests on Windows and macOS before relying on automatic recovery there. On those platforms the design refuses whenever evidence is uncertain, with one exception: the unmeasured macOS full-backlog case in §7.

Keep F07 described as **fixed for a single machine with a local disk**, not as a general or distributed lock.
