# Cargo phase 4A.2 correction report: browser-state reliability

**Date:** 8 October 2026
**Branch:** `claude/cargo-phase4a2-browser-reliability`, created from `806a93f250eac975b0aa8a76b2de1fd95ffdeff4` (`claude/cargo-phase4a1-corrections`).
**Status:** local commit only. Not pushed, merged or deployed, and no pull request. `main` and all earlier branches are unchanged. The live private site was not touched.

## 1. Summary

| ID | Finding | Phase 4A.2 status |
| --- | --- | --- |
| **M1** | A delayed `GET /api/session` response overwrote a newer acknowledged action in browser memory | **FIXED** in `public/app.js`. Responses are ordered by request tickets, and a revision guard covers session replacement. Reproduced on 4A.1 (stale $1,000.00 shown after a $970.00 bet) and verified fixed in Chromium on desktop and phone. |
| **M2** | A loaded session that disappeared during an action had its old balance restored by `render()`, and unrelated input removed the recovery control | **FIXED** in `public/app.js`. The vanished session is quarantined and its controls are locked. The recovery control survives dialog closure, input and focus events, and works from the keyboard. Nothing is created automatically. Verified on desktop and phone. |
| **M3** | Documentation claimed the browser reads before every second start; it did not | **Documentation corrected.** A conservative client-side safeguard was added: after a start with an unknown outcome, another start needs a completed read first. This is **not idempotency**, and R5 server-side idempotency remains **deferred**. The database schema and the Worker session-creation contract are unchanged. |
| **L1** | `Store` serves reads before acquisition and after release | **Investigated, not changed. Approval requested (§6).** The production server is not exposed. A correct fix changes the `Store` API used by seven direct callers, so it is broader than this phase allows. The behaviour is characterised by two new tests. |

**Not changed:** payout tables, the settlement engine, the RNG, the proof verifier, wallet calculations, collision mapping, every server file, `db/schema.ts`, `package*.json`, the build and the hosting manifest. Only `public/app.js` changed among the production code (§8).

## 2. Starting checkpoint

| Check | Result |
| --- | --- |
| Starting commit | `git rev-parse HEAD` → `806a93f250eac975b0aa8a76b2de1fd95ffdeff4`, equal to `origin/claude/cargo-phase4a1-corrections` |
| Parent | `a786d9958440b2245e237b7b90c00c58e6ca17a6` (Phase 4A), as expected |
| Working tree | Clean (`git status --porcelain` empty) |
| New branch | `git checkout -b claude/cargo-phase4a2-browser-reliability 806a93f…` |

This cloud session had been assigned the branch `claude/festive-tesla-by9666`. As instructed, the work is on the requested branch instead, and nothing was pushed to either branch.

## 3. Red baseline: reproduction on the unmodified Phase 4A.1 checkpoint

**Method.** A clean worktree of `806a93f` was used: `git worktree add --detach <scratch>/base-4a1 806a93f…`, which reports the same SHA and an empty `git status`. The new browser suite was then run against that checkout's server and client:

```
node audit/browser-phase4a2.mjs --root <scratch>/base-4a1 --out audit/results/phase4a2-red-baseline.json
```

**Result:** 10 of 12 scenarios **fail** (`audit/results/phase4a2-red-baseline.json`). The two that pass are the "legitimate replacement" guard, which must pass on both versions.

| Scenario (desktop and phone) | What happened on 4A.1 |
| --- | --- |
| M1: delayed read after a newer action | The read was answered before the bet and delivered after it. The page went from **$970.00** with round `881F14E9` back to **$1,000.00** with no round. The player's next bet was then refused with `409 STALE_REVISION`, and the scenario timed out there. Its second step, a delayed read that fails, was therefore not reached on 4A.1. |
| M1: delayed 12-second poll | The same reversion to **$1,000.00**, announced as **"Voyage synchronized."** |
| M2: session disappears during an action | The `advance` request returned 404 `SESSION_NOT_FOUND`. While the recovery dialog was open the page still showed **$970.00**, with the status "Connection lost · refresh to reconnect". After **×**, the control appeared. A synthetic `input` on the bet field then ran `render()`, which put back **$970.00** and replaced the status line, so the **Choose an option** control was **gone**. The keyboard step `page.focus('#reopen-recovery')` timed out because the control no longer existed. |
| M3: second start after an unknown outcome | After the first `POST /api/session` failed without an answer, **Start** was re-enabled at once. A click sent a **second POST with no read in between** (`POST failed → POST 200`), which created a session. |
| M3: lost start response | The server committed the start and the cookie arrived, but the response body was lost. The page still said "Saved session not found", with **Start** enabled. Clicking it would have sent a second start. |

## 4. Root causes

| Finding | Root cause in Phase 4A.1 `public/app.js` |
| --- | --- |
| M1 | `sync()` assigned `data = await api('/api/session')` unconditionally, and the poll assigned `data = next` whenever the revision *differed*. Neither checked whether the response was older than the state already shown. `visibilitychange` and the poll checked `busy` only when they *sent* a read, not when it arrived. Errors had the same problem: a late network failure called `offline()`. |
| M2 | `sessionNotFound()` wrote "—" into the balance but kept `data`. Every later `render()` (the action's `finally`, the bet `input` handler, ½ and 2×, the difficulty buttons) rewrote the balance from `data` and overwrote `#save-status`, which holds the recovery control. The action's error path also re-read and re-rendered instead of acting on the authoritative 404. A difficulty click with `data === null` would also throw (`data.round`). |
| M3 | On a start failure without a code, `startNewSession()` set `recovery = 'missing'` and called `showRecovery()`. That rebuilt the dialog with an enabled **Start** button. The toast only *advised* "Try again". The 4A.1 report and `docs/API.md` described this as the client re-reading before any second start. |

## 5. Corrections (`public/app.js` only)

### 5.1 M1: response ordering and revision guard

- **Tickets.** Every session request takes a number from one counter (`ticket`): each read, each action and each explicit start. Two values are kept: `appliedTicket`, for the response currently shown, and `actionTicket`, for the latest action or start.
- **The ordering rule.** A read is *superseded* if `t < appliedTicket || t < actionTicket`. A superseded response is ignored completely, success and failure alike. It never changes `data`, never calls `offline()` and never opens a recovery dialog.
- **Why this is enough within one tab.** A read is sent only when no action request is outstanding: the load, visibility and poll paths check `!busy`, and the read after a failed action is sent once that action's request has settled. Any action that starts afterwards supersedes it. So an applied read was always sent after every earlier action's response had arrived, and the server had already processed those actions. Ignoring a response only costs freshness; the next read or poll restores it.
- **Revision guard.** Within one session, revisions only increase. An *in-order* read with a lower revision than the one shown therefore means the cookie now names a different session, for example one started in another tab. The client sends **one confirmation read** before showing it. If the confirmation also has the lower revision, the replacement is accepted, per-session view state is reset, and the player is told: "This browser is now using a different demo session. Its current balance is shown." The poll uses the same path, so "Voyage synchronized." no longer announces a stale reversion.
- **Legitimate replacement still works.** An explicit **Start a new demo session** begins from a quarantined state (`data === null`), so its revision 0 is accepted directly. The cross-tab replacement scenario passes on both versions.
- **Actions.** Results from `POST` actions are authoritative and are applied as before. They also record `appliedTicket`.

### 5.2 M2: quarantine of a vanished session

- **`quarantine()`.** Called from `sessionNotFound()`. It:
  - sets `data = null` and clears `hiddenRoundId`;
  - sets `appliedTicket = ticket`, so reads already in flight, which may carry the old session, are discarded;
  - shows "—" for the balance, secured payout and on-board value;
  - disables the bet field, ½, 2×, the difficulty buttons, Refill, Sail, Collect all and the per-cargo buttons;
  - replaces the labels left by the interrupted action ("Sailing…", "VOYAGE UNDERWAY", "Your action is being saved.").
- **Why the balance cannot come back.** `render()` already returns at once when `data` is null, so no input event can bring back the old balance or overwrite the status line holding the recovery control. `render()` restores every control once a session is loaded.
- **Action errors.** A `SESSION_NOT_FOUND` from an action now quarantines immediately and shows the recovery dialog. It does not re-read and re-render first. **Try again** in the dialog still re-reads.
- **Small guards.** The difficulty click handler uses `data?.round`, and Refill returns when there is no session.
- **No automatic creation.** Unchanged: only the explicit button sends `POST /api/session`. The browser test counts sessions on disk before and after every step.

### 5.3 M3: retry safeguard (client-side only, not idempotency)

- **Server refusal.** If the start is answered with an error code, nothing was created, and the behaviour is unchanged.
- **No answer** (network failure, timeout or unreadable response). The client sets `startUnconfirmed`, rebuilds the dialog with **Start disabled**, explains why, and immediately reads `GET /api/session` itself:
  - **200:** the new session's cookie had arrived. It loads, with no second POST.
  - **404 `SESSION_NOT_FOUND`:** this read was sent after the failed start, which is guaranteed because the start took a ticket. The browser therefore still holds only the old cookie, and **Start** is re-enabled.
  - **Network failure:** **Start** stays disabled. **Try again** stays available.
- **What it guarantees.** In one tab, a second start is sent only after a completed read has shown that the browser holds no new session. The test shows the request order `POST failed → GET failed → GET 404 → POST 200`.
- **What it does not guarantee.** It does not prevent an extra, unused server-side session in these cases:
  - the server committed the first start, but the response *and its cookie* never arrived (for example a 7-second client timeout before the headers);
  - two tabs start at the same time;
  - the page is reloaded between the failure and the read (the flag lives in memory).
- **Status.** This is a mitigation, not idempotency. R5 (CARGO_PHASE4A1_CORRECTION_REPORT.md §5) is still required for real-wallet use. No schema, Worker or API-contract change was made.

### 5.4 Documentation

- **`docs/API.md`.** The inaccurate retry sentence is replaced with what the browser does and does not guarantee. A paragraph on read ordering and the revision guard is added for other clients.
- **`README.md`.** The missing-session paragraph now covers quarantine, the persistent control, the start safeguard and stale responses.
- **`CARGO_PHASE4A1_CORRECTION_REPORT.md`.** A correction notice is added, with inline **[4A.2]** markers on the two inaccurate statements (the R5 row and the §5 mitigation). The original text is preserved.
- **`audit/README.md`.** The new browser script is documented.

## 6. L1: store lifecycle (investigation and approval request)

### 6.1 Findings

`server/store.js`, unchanged:
- `get()` calls `ensureOwned()`, which **returns without any check when `this.lock` is null**. As a result:
  - **Before acquisition:** a `Store` that was constructed but never acquired serves the `state.json` it loaded in its constructor. That snapshot can be stale, and no lock is held.
  - **After `release()`:** `lock` is null again, so `get()` keeps serving the in-memory copy, even after another store has taken the folder and written.
- **Writes are safe in both cases.** `transaction()` acquires lazily with the create-only path. It is refused (`DATA_DIRECTORY_LOCKED`) while another owner exists. Otherwise it reloads from disk in `adopt()`, so it never loses an update.

Two characterisation tests reproduce this (`audit/tests/known-defects.test.js`, "KNOWN DEFECT L1"). They will fail on purpose once the behaviour is corrected.

**Production exposure: none found.**
- `server/index.js` awaits `store.acquire()` before `createApp()` and `listen()`.
- It releases only in the process `exit` handler.
- A lost lock sets `lostError`, so every later read is fenced (R4).

The exposure is limited to direct `Store` callers, which are tests and harnesses.

### 6.2 Proposed invariant

> A `Store` instance serves state only between a successful acquisition and its release or loss of ownership.
> - Before acquisition, `get()` acquires exactly as `transaction()` does, or throws `NOT_ACQUIRED`.
> - After `release()`, the instance is closed. Both `get()` and `transaction()` throw `STORE_RELEASED`, and it never re-acquires.
> - Inspecting a folder that another store owns uses a separate, explicitly read-only function, for example `Store.inspect(dir)` or `readSavedState(dir)`. It reads `state.json` afresh on every call and is never passed to `createApp()`.

### 6.3 Compatibility with existing direct callers

| Caller | Current use | Under the invariant |
| --- | --- | --- |
| `test/api.test.js:27` (part of `npm test`) | `new Store(dir).get(id)` while the fixture's store owns the folder | **Breaks.** A lazy acquire is refused. Needs `inspect()` |
| `audit/tests/known-defects.test.js` (F07) | `new Store(dir).get('x')` while `s1` owns the folder | **Breaks**; needs `inspect()` |
| `audit/tests/phase4a.test.js` (F07 fencing, lines ~134–140) | Fresh `Store` as a disk reader while `s2` is alive | **Breaks**; needs `inspect()` |
| `audit/tests/phase4a1.test.js` (R3 at ~115, R4 at ~248) | Fresh `Store` as a disk reader while the owner is alive | **Breaks**; needs `inspect()` |
| `audit/tests/reliability.test.js:74` | Fresh `Store` read after a fail-closed check (folder free) | Works (lazy acquire), but leaves a lock unless released |
| `audit/tests/reliability.test.js:41`, `audit/lib/harness.mjs`, the `test/api.test.js` fixture | `new Store(dir)` passed to `createApp()`, sometimes with a cookie on the first request | Works with lazy acquisition in `get()` |
| `audit/validate-system.mjs:331` (S17) | Fresh `Store` as a disk reader while `s1` owns the folder | **Breaks**; needs `inspect()` |
| `server/index.js` | `await acquire()`, then release on exit | Unaffected |

**Conclusion.** A correct fix needs:
- a new read-only API in `server/store.js`;
- changes to `get()` and `release()` semantics;
- edits to an existing `npm test` file and to five audit files.

That is a storage-API change beyond "narrowly scoped". As instructed, it is **not implemented**. **Approval is requested** for the invariant above, preferably with `get()` acquiring lazily, a closed-after-release state, and `Store.inspect()`. A partial change, such as only closing after release, would leave the before-acquisition half open and was not made.

## 7. Verification

### 7.1 Environment

- Linux 6.18.44 x86_64, ext4, running as root, in a cloud container.
- **Node 24.21.0**, the official `node-v24.21.0-linux-x64.tar.xz`, SHA-256 checked against `SHASUMS256.txt`. It was installed in a scratch directory and is not committed.
- **Node 22.22.0** (system) and npm 11.19.0.
- Playwright 1.56.1 (global install, `PLAYWRIGHT_MODULE=/opt/node22/lib/node_modules/playwright`) with **Chromium 141.0.7390.37**.
- Reduced motion was on in every browser context.
- Viewports: desktop 1440×900, and phone 390×844 with `isMobile` and touch.

### 7.2 New regression tests

**`audit/browser-phase4a2.mjs`: 6 scenarios × 2 viewports.** It spawns the real local server on a temporary data directory and scripts `/api/session` with Playwright routing.

| Scenario | Fault injected | Asserts |
| --- | --- | --- |
| M1 delayed read | A read is answered by the server before a bet and delivered after it. Then a read is answered before an advance and fails after it | Balance stays $970.00 and the round stays shown. The connection is not reported lost. Next state is consistent |
| M1 delayed poll | The natural 12 s poll is held across a bet | Balance stays $970.00. No "Voyage synchronized." |
| M1 legitimate replacement (guard) | The cookie is switched to another real session, as if from another tab | The new session's $1,000.00 is shown and is usable |
| M2 session disappears | The cookie is switched to a nonexistent session between a bet and an advance. The server responses are identical to a deleted session | Balance shows "—" from the 404 until the new session loads, with no $970.00 in between (MutationObserver log). After the action, after closing, and after input events (bet `input`/`blur`, ½, 2×, difficulty, Tab ×4, focus and visibility): the control is present and visible, the balance is "—", Sail is disabled, there are no extra reads, and no session is created. The keyboard (focus + Enter) reopens the dialog. One explicit start gives exactly +1 session, which is usable |
| M3 second start | The start fails before reaching the server; the automatic read also fails | Start is disabled and Try again is enabled. An early click sends nothing. The order is `POST failed → GET failed → GET 404 → POST 200`. Exactly +1 session |
| M3 lost response | The server commits and the cookie is set, but the body is unreadable | The new session loads automatically with one POST and +1 session |

**`audit/tests/known-defects.test.js`: +2 L1 characterisation tests.** These pass by asserting the *current* behaviour, by design.

**Red → green:**

| Run | Result |
| --- | --- |
| Against `806a93f` (Phase 4A.1) | **2/12 pass, 10/12 fail** (§3) |
| Against this branch | **12/12 pass** |

### 7.3 Commands and results

| Command | Node 24.21.0 | Node 22.22.0 |
| --- | --- | --- |
| `node audit/browser-phase4a2.mjs --root <worktree of 806a93f>` (red baseline) | 2/12, **FAIL as expected** (`audit/results/phase4a2-red-baseline.json`) | — |
| `node audit/browser-phase4a2.mjs` | **12/12** on the final tree: 2 standalone runs and 1 inside `run-all`. Earlier iterations differed only in the quarantine labels and passed 4 standalone and 2 `run-all` runs | **12/12** on the final tree: 1 standalone and 1 inside `run-all --quick`; also 1 earlier `--quick` run |
| `node audit/browser-check.mjs` (existing 4A/4A.1 browser suite) | **6/6** on the final tree: 1 standalone and 1 inside `run-all`; also 3 earlier runs | **6/6** on the final tree inside `run-all --quick`; also 1 earlier run |
| `PLAYWRIGHT_MODULE=… node audit/run-all.mjs` (full mode, final tree) | **ALL PASSED**: maths 13/13, RNG 8/8 (108 vectors), system 21/21, F03 storage, lock stress 6+6 rounds, regression **111/111** (109 earlier + 2 L1), both browser suites, `npm test` 12/12, `test:hosted` pass, `test:collisions` pass (`audit/results/manifest.json`) | `--quick`: **ALL PASSED**, same counts (no F03 or stress, by design) |
| `npm ci && npm run build` | Build OK; `dist/client/app.js` is byte-identical to `public/app.js` | — |
| Visual check, ad hoc (not committed): after closing the dialog, full-page screenshots on phone and desktop | Balance "—". Sail and stage read "Session not found". **Choose an option** is visible in the footer status line on both layouts. No horizontal overflow | — |

The claim cross-check reports 2 mismatches, the same as on the base. These are pre-existing differences in the original audit text. Changes in `math.json`, `rng.json`, `claims.json` and `simulation.json` are timestamps and timings only.

### 7.4 Protected files and mathematics

- **`run-all` production-integrity check:**
  - 0 unexpected changes;
  - 0 protected files changed (`server/fairness.js`, `server/game.js`, `public/collision.js`, `db/schema.ts`, `.openai/hosting.json`);
  - 0 changes to payout, settlement, RNG, proof or collision files since `fca90c6`.
- **`git diff 806a93f`** shows these files unchanged: every `server/*.js`, `public/math.js`, `public/fairness.js`, `public/scene.js`, `public/index.html`, `public/styles.css`, `db/schema.ts`, `drizzle/`, `package.json`, `package-lock.json`, `build/` and `.openai/hosting.json`.
- **The only production code change is `public/app.js`.** It changes which already-received server snapshot is displayed. It never computes or alters an amount.
- **Behaviour.** The exact maths, RNG known-answer vectors and collision checks pass unchanged.
- **Scope and secrets.** No `data/`, `.env`, credentials or seeds were added. `dist/` and `node_modules/` are git-ignored.

## 8. Files changed (relative to `806a93f`)

| File | Change |
| --- | --- |
| `public/app.js` | M1 ticket ordering and revision guard (`readSession`, `commit`, `superseded`), with the poll using the same path. M2 `quarantine()` and the authoritative handling of `SESSION_NOT_FOUND` from actions. M3 `startUnconfirmed` safeguard with an automatic read. `data?.` guard on the difficulty buttons and a Refill guard |
| `docs/API.md`, `README.md` | Retry and ordering behaviour stated accurately |
| `CARGO_PHASE4A1_CORRECTION_REPORT.md` | Correction notice and **[4A.2]** markers; original text kept |
| `CARGO_PHASE4A2_CORRECTION_REPORT.md` | This report |
| `audit/browser-phase4a2.mjs` | **New** browser regression suite (M1–M3, desktop and phone, `--root` for baselines) |
| `audit/tests/known-defects.test.js` | +2 L1 characterisation tests |
| `audit/run-all.mjs` | Runs the new browser suite when Playwright is available; comment updated. Integrity lists unchanged |
| `audit/README.md` | Documents the new script |
| `audit/results/browser-phase4a2.json`, `phase4a2-red-baseline.json` | **New** evidence (fixed run and 4A.1 red baseline) |
| `audit/results/*` (others) | Regenerated by the final full Node 24 run; timings and timestamps only |

## 9. Remaining limitations and unresolved findings

| Item | Status |
| --- | --- |
| **R5** server-side idempotency of `POST /api/session` | **DEFERRED** (unchanged). The M3 safeguard narrows the window in one tab only (§5.3) |
| **L1** store lifecycle | **OPEN, approval requested** (§6). No production path found |
| Cross-tab use | Ordering is per tab. The revision guard detects a replacement only when the new session's revision is lower. One with an equal or higher revision is shown as the current session, which is the server's truth for that cookie. An action sent from a tab that has not yet seen the replacement is rejected by the existing revision and seed-commitment checks in almost all cases. A refill whose revision happens to match is the exception (play money only, pre-existing). |
| Cookie removed rather than session deleted | A request without any cookie still makes `GET /api/session` create a new session. This is the documented new-visitor contract and was left unchanged. The new session appears through the replacement path with a notice. |
| Phone layout | The recovery control lives in the footer status line, as in 4A.1. On a 390 px phone it is below the fold: visible after scrolling and reachable by keyboard, which was tested. The red connection dot in the header is the only above-the-fold indicator once the dialog is closed. |
| Old round visuals | After quarantine, the previous round's ship and container cards stay drawn but locked ("Unavailable"). No balance from the vanished session is shown. |
| Test method for M2 | The disappearance is simulated by pointing the cookie at a nonexistent session. The server cannot tell this apart from a deleted row, but a real deletion of a live row was not exercised in the browser. |
| Platforms | Chromium only, on Linux. Firefox, Safari/WebKit, and real iOS or Android devices were not run. |
| Live site | **Not deployed.** The phone link still serves the previously published version. |

## 10. Recommendation

**GO for independent review. Do not merge before that review.**

Suggested review order:
1. **`public/app.js`**: the ticket rule `superseded()` and every path that sends `GET /api/session` (initial load, visibility, poll, Try again, Load, after an action error).
2. **`quarantine()`**, and whether any remaining path can render without `data`.
3. **The M3 wording** in `docs/API.md`, to confirm it promises nothing beyond the code.
4. **A decision on the L1 invariant** in §6, and separately on R5.

Re-run `node audit/browser-phase4a2.mjs --root <checkout of 806a93f>` to see the red baseline independently.
