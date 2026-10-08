# Cargo phase 4A.3 correction report: browser state consistency

**Date:** 8 October 2026
**Repository:** `sarimichael/cargo-game` (private)
**Base:** `9937de16a55c14f78111a31e48161ac792203e58` (`claude/cargo-phase4a2-browser-reliability`)
**Branch:** `claude/cargo-phase4a3-browser-consistency`, created from that exact SHA
**Status:** local commit only. Not pushed, merged or deployed, and no pull request. `main` and every earlier branch are unchanged. The live private site was not touched, and the phone link still serves the previously published version.

> **Correction notice (Phase 4A.4, 8 October 2026, branch `claude/cargo-phase4a4-ordering-correction`).** The independent
> Codex review of `d157909` returned **NO-GO**; this checkpoint was **not** accepted. M-01 was confirmed fixed and the
> original M-02 scenario passed, but two claims here were broader than the evidence:
> - **M-02 ordering.** An unchanged poll was accepted without advancing `appliedTicket`. An older confirmation read
>   could therefore still be applied after it and display another session (A → B → A, reproduced by Codex and again
>   in CARGO_PHASE4A4_CORRECTION_REPORT.md, local server and Worker, desktop and phone).
> - **Test determinism.** The `compared >= 10` assertion in `audit/tests/phase4a3.test.js` depended on random voyage
>   length. It failed 6 times in 1,000 runs of this commit's test file, although every equality assertion held.
>
> Codex also reproduced a pre-existing session-start timeout classification defect, which is out of scope and unchanged.
> The original text is kept; the affected sentences are marked **[4A.4]**.

## 1. Summary

| ID | Finding (independent review, NO-GO for 4A.2) | Phase 4A.3 status |
| --- | --- | --- |
| **M-01** | Outstanding reads could resurrect a quarantined session | **FIXED** in `public/app.js` (one statement). Reproduced on `9937de1` with a genuine removal from server storage: after the 404, a late success brought back **$970.00**, the round, "Voyage in progress", an enabled **Sail**, and removed the recovery control. Verified fixed on desktop and phone. |
| **M-02** | A different session with an equal revision was ignored by the poll | **FIXED** in `public/app.js` (one helper, one condition). **[4A.4] Overbroad: the reproduced scenario passed, but a delayed confirmation read could still display the other session after a newer unchanged poll (§5.2).** Reproduced on `9937de1`: with the cookie switched from A ($970.00, revision 1) to B ($997.00, revision 1), the natural poll kept A's wallet and round, and **Sail** failed with "Voyage not found.". Verified fixed on desktop and phone. |

**Not changed:** every server file, the API contract, the database schema, payouts, settlement, RNG, the proof verifier, wallet calculations, collision mapping, `package*.json`, the build and the hosting manifest. `public/app.js` is the only production code changed. No session identifier, cookie, credential or seed is exposed. Both fixes are client-side; neither is server-side idempotency (R5 remains deferred).

**Out of scope and not implemented:** F11, R5, L1, L-02, F03, F09, RTP changes, gameplay features, real-money integration, deployment changes.

## 2. Starting checkpoint

| Check | Result |
| --- | --- |
| Remote | `origin` = `https://github.com/sarimichael/cargo-game` |
| Source branch | `git fetch origin claude/cargo-phase4a2-browser-reliability` → `FETCH_HEAD` = `9937de16a55c14f78111a31e48161ac792203e58`; `git ls-remote` agrees |
| Ancestry | `9937de1` → parent `cc34467d885a08ff1a900b5b220dcb406e21a679` (4A.2 implementation) → `806a93f250eac975b0aa8a76b2de1fd95ffdeff4` (4A.1); `main` (`13a9805`) is an ancestor |
| Working tree | Clean (`git status`: nothing to commit) |
| New branch | `git checkout -b claude/cargo-phase4a3-browser-consistency 9937de16a55c…` → `HEAD` = `9937de1` |
| Other remote branches | Unchanged: `main` 13a9805, phase2 da135aa, phase3 fca90c6, phase4a a786d99, phase4a1 806a93f, rtp-model 724c954. No `claude/cargo-phase4a3-*` branch existed on the remote |

The session's checkout started detached at `main`. The work was done only on the new branch, created from the verified SHA.

## 3. Red baseline on the unmodified Phase 4A.2 checkpoint

**Method.** A clean worktree of the base: `git worktree add --detach <scratch>/base-4a2 9937de1…` (HEAD `9937de1`, empty `git status`). The new browser suite, written before any production change, ran that checkout's server and client:

```
PLAYWRIGHT_MODULE=… node audit/browser-phase4a3.mjs --root <scratch>/base-4a2 --out audit/results/phase4a3-red-baseline.json
```

The result file records the root's `HEAD`, an empty list of uncommitted changes and the SHA-256 of the tested `public/app.js` (`0f3d9e02…fe1c0`, the 4A.2 file). Node 24.21.0, Chromium 141.0.7390.37.

**Result: 8 of 14 pass, 6 of 14 fail.** The six failures are the three defect scenarios, on both viewports. The eight passes are guard scenarios that are designed to pass on both versions (§6.2). Desktop and phone fail the same assertions with the same values (only round IDs differ).

| Scenario | Failing assertions on `9937de1`, with the recorded values |
| --- | --- |
| **M-01 newest outstanding read cannot restore a deleted session** | After the delayed success: balance **"$970.00"**, secured "$0.00", on board "$30.00" (expected "—"); enabled controls `["sail-button"]` (expected none); status "Voyage in progress", stage "READY TO DEPART", Sail "Sail to stop 01", cargo "Ready to sail" ×3 (expected "Session not found"/"Unavailable"); status line "Your voyage is saved" with **no recovery control**; balances shown after the 404: `["—", "$970.00"]`. The keyboard step `page.focus('#reopen-recovery')` then timed out because the control no longer existed. |
| **M-01 stale read released during an explicit recovery read** | While the player's **Try again** read was outstanding, the stale success showed **"$970.00"**, enabled **Sail** and "Voyage in progress". The legitimate read then loaded B ($997.00), so the end state was right but A's balance had reappeared in between: `["—", "$970.00"]`. |
| **M-02 equal-revision session replacement through the natural poll** | Setup held: A 97,000 ¢ at revision 1, B 99,700 ¢ at revision 1, no visibility events, one poll read (desktop: 11.8 s after the cookie switch). After the poll: balance **"$970.00"** (expected "$997.00"); round still A's, mode "easy", bet "30.00" (expected B's round, "hard", "3.00"); no notice. **Sail** then sent `POST /api/rounds/<A's round>/advance` with B's cookie: **404 "Voyage not found."**; B's round stayed at step 0. |

Observed but not counted as a failure: in the poll-path guard, the 4A.2 client did **not** resurrect the session. The code shows why, and it is accidental (§4.1): after quarantine, the poll's condition reads `data.session` with `data === null`, throws a `TypeError`, and its `catch` calls `offline()`. The error is swallowed, so this is inferred from the code and from the absence of any state change, not from a logged error.

## 4. Root causes

### 4.1 M-01

- Tickets come from one counter. `superseded(t)` is `t < appliedTicket || t < actionTicket`.
- `quarantine()` set `appliedTicket = ticket`. The most recently sent read holds exactly `ticket`, so `t < appliedTicket` was false for it and it was **not** superseded. Every older read was.
- If that read's answer was a success sent before the removal, `readSession()` returned it, and `sync()` (visibility, **Try again**, **Load**) called `commit()`. That set `data` back to the removed session, `recovery = null` and `connected = true`, and `render()` re-enabled the controls and replaced the status line that holds the recovery control.
- The newest read is usually not the one that gets the 404, but it can be: two reads overlap (visibility and poll, two visibility events, a confirmation read), and the older one reaches the server later or is answered later. The red baseline holds the older read before the server and lets the newer one through, which is that ordering.
- On 4A.2 the poll path was protected only by accident. Its condition read `data.session.revision` with `data === null`, threw, and the `catch` called `offline()`.

### 4.2 M-02

- `readSession()` flagged a replacement only for a **lower** revision.
- The poll applied a read only if it was a replacement, the revision **differed**, or the page was offline.
- Revisions count changes per session, and every new session starts at 0. Two sessions with the same number of changes have the same revision. For A and B both at revision 1, the poll's read of B was in order, not a replacement, at an unchanged revision, and online, so it was **dropped**. The page kept A until a visibility event or an action.
- A visibility event did apply B (`sync()` commits unconditionally), but silently and without resetting per-session view state.

## 5. Corrections (`public/app.js` only)

The complete production diff is 9 insertions and 5 deletions. Three of the changed lines are code; the rest are comments.

### 5.1 M-01: quarantine takes its own ticket

```diff
- data=null;hiddenRoundId=null;appliedTicket=ticket;
+ data=null;hiddenRoundId=null;appliedTicket=++ticket;
```

`quarantine()` now consumes a ticket, so it is an ordered event that comes after every request already sent. The ordering rule (`superseded`) is unchanged.

**Effect on every request, by when it was sent:**

| Request | Ticket vs. the quarantine ticket `q` | Result |
| --- | --- | --- |
| Any read sent before the 404 was handled, **including the newest** | `t < q` | Superseded. Success **and** failure are ignored: `readSession()` checks before using an answer and before reporting a 404 or an error. No `commit()`, no `offline()`, no second dialog |
| A read sent afterwards: **Try again**, **Load my new session**, the read after a start | `t > q` | Eligible, as before |
| An explicit start (`actionTicket = ++ticket`) | `> q` | Unchanged; it still supersedes older reads |
| An action (`actionTicket = ++ticket`) | — | Cannot start while quarantined (`action()` returns without `data`) |

**Why this changes nothing else.**
- No other code compares a ticket with the value `quarantine()` sets.
- `commit()` sets `appliedTicket` to the committed read's own ticket, and `action()` to its own ticket. No other request shares either.
- So the only response whose treatment changes is the one holding `ticket` at the moment of quarantine: the defect case.
- Changing `<` to `<=` in `superseded()` would also reject it, but it would change the comparison for every path. Making quarantine an ordered event keeps the rule as it was.

**The rest of the lifecycle, inspected:**
- **Async action completion.** Reads are sent only when no action is outstanding: load, visibility and poll check `!busy`, and the read after a failed action is sent once its request has settled. A read sent before an action is superseded by `actionTicket`, so its 404 is ignored and the action reports the session's state itself. An action's 404 quarantines from its own `catch`, and its `finally` calls `render()`, which returns without `data`. No action result can arrive after a quarantine.
- **Rendering.** `data` is assigned only by `commit()` (ordered reads) and `action()`. `render()` returns while `data` is null.
- **Polling and visibility.** Both are skipped while `recovery` is set. With every older read superseded, a poll read that is not superseded always has `data`, so the accidental `TypeError` path above can no longer be reached.
- **Recovery state.** `sessionNotFound()`, the dialog, the reopen control and the M3 `startUnconfirmed` logic are unchanged.

### 5.2 M-02: equal revision with different contents is a replacement

```diff
+const sameState=(a,b)=>JSON.stringify([a.session,a.round,a.history])===JSON.stringify([b.session,b.round,b.history]);
…
- const replaced=!!data&&next.session.revision<data.session.revision;
+ const replaced=!!data&&(next.session.revision<data.session.revision||next.session.revision===data.session.revision&&!sameState(next,data));
```

- **Premise.** Every successful action increments the revision exactly once (`s.revision++` in `server/app.js` and `server/worker.js`), and reads never change a session. Within one session, therefore:
  - a lower revision cannot occur;
  - an equal revision means unchanged state.
- **The rule.** An in-order read at an equal revision whose displayed state differs comes from a different session. It goes through the existing replacement path:
  1. one confirmation read;
  2. `commit()` with `replaced`;
  3. per-session view state reset;
  4. the notice "This browser is now using a different demo session. Its current balance is shown."
- **The poll needed no change.** It already applies `read.replaced`. **[4A.4] Incorrect: the poll accepted an unchanged read without advancing `appliedTicket`, so an older pending confirmation stayed eligible and could later be applied.**
- **What is compared.** `session`, `round` and `history`: everything the page displays or sends back (revision, seed commitment, round ID).
  - `replayed` is excluded because action responses may add it.
  - `config` is excluded because it is not displayed.
  - Comparing whole snapshots would have flagged every replayed action as a different session; this was checked against both adapters.
- **No identifier needed.** The fix does not assume the revision identifies a session, and it adds no session identifier to the API.
- **Same-session safety.** A false positive would show a wrong notice and could replace a typed bet. Two tests guard against this:
  - `audit/tests/phase4a3.test.js` uses the `sameState` expression extracted from `public/app.js`. On both adapters, it checks that action responses (including a replay) and later reads of an unchanged session always compare equal. It also checks that two sessions at the same revision compare different.
  - The browser guard checks that an unchanged poll causes no re-render, and that the typed bet and focus are kept.

### 5.3 Documentation

| File | Change |
| --- | --- |
| `CARGO_PHASE4A2_CORRECTION_REPORT.md` | Correction notice, plus inline **[4A.3]** markers on the unsupported quarantine and equal-revision statements (§1 M1 and M2 rows, §5.1 revision guard, §5.2 `appliedTicket` bullet and "Why the balance cannot come back", §9 cross-tab row and M2 test-method row). Original text kept |
| `docs/API.md` | Read-ordering paragraph: reads sent before a `SESSION_NOT_FOUND` are discarded, the newest included. Equal-revision replacement is detected by contents, because there is no session identifier |
| `README.md` | The missing-session paragraph: the cleared balance stays cleared, and a replacement is shown even at an equal revision |
| `audit/README.md`, `audit/run-all.mjs` | New suite and test documented; `run-all` runs the new browser suite when Playwright is available |

## 6. Verification

### 6.1 Environment

- Linux 6.18.44 x86_64 cloud container.
- **Node 24.21.0** (official tarball, SHA-256 `fd8e59d5…cb2d6` checked against `SHASUMS256.txt`, in a scratch directory, not committed) with **npm 11.19.0**.
- **Node 22.22.0** (system) with **npm 10.9.4**.
- Playwright 1.56.1 (`PLAYWRIGHT_MODULE=/opt/node22/lib/node_modules/playwright`), **Chromium 141.0.7390.37**.
- Reduced motion on. Desktop 1440×900; phone 390×844 with `isMobile` and touch.

### 6.2 New tests

**`audit/browser-phase4a3.mjs`: 7 scenarios × 2 viewports, 14 runs.**

The suite runs the real `server/app.js` and `server/store.js` in-process on a temporary directory. A session is **genuinely removed** with a test-only `store.transaction(state => delete state.sessions[id])`, and the browser receives the server's own 404 `SESSION_NOT_FOUND`. Requests to `/api/session` are scripted with Playwright routing. A request can be held before it reaches the server, or answered at once and delivered later; holds stay within the page's 7-second request timeout. Every assertion is recorded by name with its actual value.

| Scenario | Type | Ordering exercised | Asserts |
| --- | --- | --- | --- |
| M-01 newest outstanding read | **Defect (spec)** | Read 1 held before the server. Read 2 (newest) answered 200 with A. A removed. Read 1 gets a genuine 404. Dialog closed. Read 2's success delivered | Quarantine holds: "—" values, no enabled control, "not found" labels, recovery control present and visible, no notice, A's $970.00 never shown again. Keyboard reopen, one explicit start (+1 POST, +1 session), the new session accepts a bet. A stays removed |
| M-01 stale read during an explicit recovery read | **Defect (concurrency)** | As above. Then the cookie names B (another tab), the player clicks **Try again** (held, answered 200 with B), and A's stale success is delivered first | Quarantine holds while the legitimate read is outstanding. Then B is shown ($997.00, B's round, Hard, $3.00) and is playable. **Sail** advances B on the server. A stays removed |
| M-01 delayed failures | Guard | Three reads: 404 (trigger), a 404 delivered late, a network failure delivered late | Nothing changes; a dialog the player closed is not reopened; no error notice; no automatic session |
| M-01 delayed poll response | Guard (polling) | The newest outstanding read is the natural 12-second poll | Quarantine holds; recovery works |
| M-01 genuine removal reported by an action | Guard (actions) | A read answered 200 is outstanding, A is removed, **Sail** gets a genuine 404, then the read is delivered | Quarantine holds; recovery works. This closes the 4A.2 test-method gap (it only switched cookies) |
| M-02 equal-revision replacement through the natural poll | **Defect (spec)** | A ($970.00, rev 1) loaded. B ($997.00, rev 1, Hard) created through the API. Cookie switched. Only the natural poll runs; no visibility event is dispatched (counted) | B's balance, round, difficulty, stake, stage and **Sail** label are shown, with the replacement notice. **Sail** advances B on the server (step 1, rev 2) and leaves A untouched (step 0, rev 1, 97,000 ¢) |
| M-02 same-session polling | Guard (invariant 9) | Settled round from action responses; **New voyage**; bet "45.67" typed. Natural poll of the unchanged session; then another client of the same session refills | Unchanged poll: **0 re-renders**, typed bet and focus kept, no notice. Refill: $1,000.00 shown as "Voyage synchronized.", typed bet and focus kept |

**Validity checks.** Each scenario that uses holds asserts that only the scripted reads were sent in the window: no natural poll interfered, and the window stayed under 11.5 s. The poll scenario instead asserts exactly two reads, its own and one poll. A violation fails the scenario; it is not treated as a pass.

**`audit/tests/phase4a3.test.js`: 5 `node:test` tests.** The extracted `sameState` expression is checked on both adapters:
- action responses, a replay and repeated reads of one session compare equal (≥10 states per adapter); **[4A.4] the count depended on random voyage length and failed 6 times in 1,000 runs; the rule now requires each kind of change instead;**
- two different sessions at revision 0 and at revision 1 compare different.

### 6.3 Red → green

| Run | Result |
| --- | --- |
| `browser-phase4a3.mjs --root <worktree of 9937de1>` | **8/14, FAIL as expected** (`audit/results/phase4a3-red-baseline.json`, §3) |
| `browser-phase4a3.mjs` on this branch | **14/14** (`audit/results/browser-phase4a3.json`) |

### 6.4 Commands and results

| Command | Node 24.21.0 (npm 11.19.0) | Node 22.22.0 (npm 10.9.4) |
| --- | --- | --- |
| `node audit/browser-phase4a3.mjs --root <worktree of 9937de1>` (red baseline) | **8/14, FAIL as expected** | — |
| `node audit/browser-phase4a3.mjs` (corrected) | **14/14** in 4 runs: 3 standalone (1 during development, 2 repeat runs) and 1 inside `run-all` | **14/14** in 2 runs: 1 standalone and 1 inside `run-all --quick` |
| `node audit/browser-phase4a2.mjs` (4A.2 suite, unchanged) | **12/12** in 2 runs: 1 standalone and 1 inside `run-all` | **12/12** inside `run-all --quick` |
| `node audit/browser-check.mjs` (4A/4A.1 suite, unchanged) | **6/6** in 2 runs: 1 standalone and 1 inside `run-all` | **6/6** inside `run-all --quick` |
| `node --test audit/tests/*.test.js` | **116/116** pass, 0 fail, 0 skipped, 0 todo (111 earlier + 5 new). Standalone and inside `run-all` | **116/116** inside `run-all --quick` |
| `node audit/run-all.mjs` (full; produces the committed results) | **ALL PASSED**. Exact maths 13/13; claim cross-check 2 known mismatches (below); RNG 8/8 with 108 vectors; simulation statistics: 107 p-values, 0 Bonferroni rejections; system 21/21; F03 storage measured; F07 lock stress 6+6 rounds (0 lost while held, 0 wrongly acquired); regression 116/116; three browser suites as above; `npm test` 12/12; `test:hosted` pass; `test:collisions` pass | `--quick`: **ALL PASSED**, same counts (F03 and lock stress skipped by design) |
| `npm test` | **12/12** standalone | **12/12** inside `run-all --quick` |
| `npm ci && npm run build` | **Build OK**; `dist/client/app.js` is byte-identical to `public/app.js` | — |

**Not failures:**
- **Claim cross-check.** It reports the same 2 mismatches as on every earlier base: the original audit's headline rounding (N04). That step exits 0 by design.
- **Characterisation tests.** Of the 116 regression tests, **14** are "KNOWN DEFECT" tests (F01 ×2, F03, F05 ×2, F09 ×4, F11 ×3, L1 ×2), and 3 system checks are of type `defect` (S14 F01/F09, S16 F05, S19 F11). They **pass because the defects still reproduce**. None of these defects is fixed.

**Environmental anomalies:**
- **`npm ci` under npm 11.19.0** printed `install-scripts` warnings: esbuild's `postinstall` was not run. The build completed; the platform binary package `@esbuild/linux-x64` was installed. `package.json` and `package-lock.json` are unchanged.
- **Timing.** The suite's timing windows are guarded by validity checks; none was violated in any recorded run. One timing problem was found and fixed before those runs. In the first exploratory baseline run, the poll guard held a read for about 12 s, past the page's own 7-second request timeout. That was a test-design error, fixed as described in §10.
- **Nondeterminism.** No test failed nondeterministically in any run. **[4A.4] True of the runs recorded here, but the `compared >= 10` assertion is nondeterministic (measured failure rate 0.6%).**

### 6.5 Protected files

- `git diff 9937de1` for `server/`, `db/`, `drizzle/`, `build/`, `package.json`, `package-lock.json`, `.openai/`, `public/math.js`, `public/fairness.js`, `public/collision.js`, `public/scene.js`, `public/index.html` and `public/styles.css` is **empty**.
- **`run-all` integrity check** (Node 24 full and Node 22 quick) compared 42 production files:
  - 0 unexpected changes;
  - 0 protected files changed (`server/fairness.js`, `server/game.js`, `public/collision.js`, `db/schema.ts`, `.openai/hosting.json`);
  - 0 payout, settlement, RNG, proof or collision files changed since `fca90c6`.
- **The only production code change is `public/app.js`.** It changes which received server snapshot is displayed. It never computes or alters an amount.
- **No `data/`, `.env`, credentials or seeds were added.** `dist/` and `node_modules/` are git-ignored.

## 7. Required invariants

| # | Invariant | Evidence |
| --- | --- | --- |
| 1 | Old async responses cannot restore state invalidated by quarantine | §5.1 ticket argument; M-01 newest read, stale read during recovery, delayed failures, delayed poll, removal via action (14/14) |
| 2 | New, legitimate recovery reads remain eligible | **Try again** loads B after quarantine; keyboard reopen and explicit start in every M-01 scenario; 4A.2 M3 scenarios (read after an unknown start) |
| 3 | Accepted authoritative reads synchronise the correct wallet and round | M-02 equal revision (poll); 4A.2 "legitimate replacement" (lower revision); M-02 guard (same-session refill). **[4A.4] Not held: a stale confirmation could overwrite a newer accepted read** |
| 4 | Equal revisions do not conceal session replacement | M-02 equal revision, desktop and phone; `phase4a3.test.js` (sessions at equal revisions compare different) |
| 5 | An older read cannot overwrite a newer acknowledged action | 4A.2 M1 delayed read and delayed poll (12/12); the ordering rule is unchanged |
| 6 | Quarantined sessions cannot execute play-money actions | No enabled control in every quarantine snapshot. `action()` requires `data`. In all 10 M-01 runs, the request log shows no POST between the 404 and the player's explicit recovery |
| 7 | Browser recovery remains accessible after closing its dialog | Control present and visible after closing, after late successes and failures; reopened from the keyboard in every M-01 scenario |
| 8 | Uncertain session-start retries retain the 4A.2 safeguards | 4A.2 M3 scenarios pass unchanged (`POST failed → GET failed → GET 404 → POST 200`; lost body loads with one POST) |
| 9 | Same-session polling causes no unnecessary resets or input loss | M-02 guard: 0 re-renders, typed bet and focus kept; `phase4a3.test.js` (no false replacement, including replays) |
| 10 | No client-only fix is described as server-side idempotency | Both fixes are described as client-side; R5 is unchanged and deferred (§9) |

## 8. Files changed (relative to `9937de1`)

| File | Change |
| --- | --- |
| `public/app.js` | M-01 `quarantine()` ticket; M-02 `sameState` and the `replaced` condition; comments |
| `audit/browser-phase4a3.mjs` | **New** browser regression suite (M-01, M-02, desktop and phone, `--root` for baselines) |
| `audit/tests/phase4a3.test.js` | **New** server-premise tests for the equal-revision check, both adapters |
| `audit/results/phase4a3-red-baseline.json`, `browser-phase4a3.json` | **New** evidence: 4A.2 red baseline and corrected run |
| `audit/run-all.mjs`, `audit/README.md` | Runs and documents the new suite and test |
| `README.md`, `docs/API.md` | Behaviour stated accurately (§5.3) |
| `CARGO_PHASE4A2_CORRECTION_REPORT.md` | Correction notice and **[4A.3]** markers; original text kept |
| `CARGO_PHASE4A3_CORRECTION_REPORT.md` | This report |
| `audit/results/*` (others) | Regenerated by the final full Node 24 `run-all`, as in earlier phases. `math.json`, `rng.json`, `claims.json`, `simulation.json`, `lock-stress.json` and `browser.json` differ only in timestamps and timings; `browser-phase4a2.json` also in random round IDs. `system.json` and `storage.json` also differ in outcome counts and byte measurements, because those checks drive the real adapters with unseeded production `newSeed()` (`audit/README.md`, Determinism); 21/21 still pass. `manifest.json`: new hashes, durations and steps |

## 9. Known limitations and unresolved items

| Item | Status |
| --- | --- |
| **R5** server-side idempotency of `POST /api/session` | **DEFERRED**, unchanged. The 4A.2 start safeguard is client-side and per tab |
| **L1** store lifecycle | **OPEN, approval requested** in the 4A.2 report §6. The two "KNOWN DEFECT L1" tests still assert the defective behaviour by design; their passing does **not** mean L1 is fixed |
| Other characterised defects | The 14 "KNOWN DEFECT" tests (F01, F03, F05, F09, F11, L1) and the `defect` system checks (S14 F01/F09, S16 F05, S19 F11) still pass **because the defects still reproduce**. F03 is also `mitigated` (S15). None was addressed in this phase |
| A different session at a **higher** revision | Shown correctly (its wallet and round) by the poll, but announced as "Voyage synchronized." rather than as a different session. The displayed state is right; only the wording is imprecise. Pre-existing; not changed to keep the fix minimal |
| Discarding is conservative | After a confirmed missing session, a read sent before that answer is discarded even if it carried a valid session (for example, the cookie had just been changed by another tab). The player chooses **Try again** to load it. If they press **Start** instead, the server answers `SESSION_EXISTS` for a live cookie and the page loads that session; nothing extra is created. This follows from the code (`startNewSession()` treats `SESSION_EXISTS` as started) and is not exercised in the browser |
| Old round visuals while quarantined | Unchanged from 4A.2 and identical on both versions. The removed session's round label, ship scene and container cards stay drawn but locked ("Unavailable"), and its stage title remains. No balance or enabled control from it is shown. Clearing them would be a UI change outside this scope |
| Cross-tab and reload | Ordering is per tab; the 4A.2 limitations on two tabs starting at once and reloads are unchanged |
| Phone | The recovery control remains in the footer, below the fold at 390 px (keyboard access tested) |
| Platforms | Chromium only, on Linux. Firefox, WebKit/Safari and real devices were not run |
| Hosted adapter in the browser | The browser suite drives the local server. Worker row deletion → 404 `SESSION_NOT_FOUND` is covered at API level (`audit/tests/phase4a.test.js`, `reliability.test.js`), and `phase4a3.test.js` covers the Worker's snapshots. No browser was run against the Worker |
| Live site | **Not deployed.** The phone link still serves the previously published version |

## 10. Claims compared with evidence

- **Corrected 4A.2 claims** (marked **[4A.3]** in that report):
  - "reads already in flight … are discarded": false for the newest read;
  - "the revision guard covers session replacement": only lower revisions;
  - "One with an equal or higher revision is shown": not by the poll, for an equal revision.
- **The 4A.2 poll path** looked safe only by accident (§4.1). This report does not count that as a 4A.2 protection.
- **The test method differs from 4A.2.** The new suite runs the server in-process rather than spawning `server/index.js`, so it can remove a session from storage. Request handling is the same `createApp(store)`. The lock watcher and ownership-loss handler of `server/index.js` are not active, which M-01 and M-02 do not involve.
- **M-02's "other tab"** is a second API client whose cookie is placed in the browser. No second browser tab was driven.
- **Screenshots** (`cargo-4a3-m01-<view>.png`, written to the OS temp directory) were inspected but are not committed.
- **The red baseline was produced by the final committed script.** One timing fix was made after a first exploratory baseline run: in the poll guard, the first read was being held about 12 s and was abandoned by the page's 7-second timeout. That run is not committed.
- **The committed browser evidence was produced from the working tree before the commit**, so its `meta.rootHead` is `9937de1` with `public/app.js` listed as modified. Its `meta.sha256["public/app.js"]` is `285a90c30acc23414c0f129545311492a49c12fca2ff992157075bc79632446e`, the committed file. The red baseline's is `0f3d9e02c21063af25bcaaaf2beba59d15a10e2bd6777acf7e7bc6c4c84fe1c0`, the `9937de1` file.

## 11. Recommendation

**Ready for independent Codex review. Do not merge or deploy before that review.**

Suggested review order:
1. **`public/app.js`**: `quarantine()` (§5.1), `readSession()` and `sameState` (§5.2), against every caller: load, visibility, poll, Try again, Load, and the read after a failed action.
2. **The red baseline:** re-run `node audit/browser-phase4a3.mjs --root <checkout of 9937de1>`.
3. **The limitations in §9**, especially the higher-revision wording and the old round visuals while quarantined.
