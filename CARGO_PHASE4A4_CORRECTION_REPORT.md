# Cargo phase 4A.4 correction report: confirmation ordering

**Date:** 8 October 2026
**Repository:** `sarimichael/cargo-game` (private)
**Base:** `d157909576426a14a3c82a54cfaaa9a6f619fef3` (`claude/cargo-phase4a3-browser-consistency`), whose parent is `9937de16a55c14f78111a31e48161ac792203e58`
**Branch:** `claude/cargo-phase4a4-ordering-correction`, created from that exact SHA
**Status:** local commit only. Not pushed, merged or deployed, and no pull request. The remote branch was not created. `main` and every earlier branch are unchanged. The live private site was not touched.

**Phase 4A.3 was not accepted.** The independent Codex review of `d157909` returned NO-GO. This phase corrects the blocking finding and the test defect from that review. It has not itself been independently reviewed.

## 1. Summary

| Codex finding on `d157909` | Severity | Phase 4A.4 status |
| --- | --- | --- |
| M-01 deleted-session quarantine resurrection | — | Confirmed fixed by Codex. Re-verified here: 4A.3 suite and guard G-03, local and Worker |
| M-02 original equal-revision replacement | — | Passed in Codex's review. Re-verified here: 4A.3 suite and guard G-01 |
| **M-02 confirmation-ordering race (A → B → A)** | Medium, **blocking** | **FIXED** in `public/app.js` (4 code lines). Reproduced on `d157909` on the local server and the Worker, desktop and phone (8 of 8 runs fail). All 8 pass after the fix |
| Nondeterministic `compared >= 10` in `audit/tests/phase4a3.test.js` | Low | **FIXED.** The old assertion failed 6 times in 1,000 runs; the repaired test passed 1,000 of 1,000 |
| Session-start timeout classification | Medium, pre-existing | **Out of scope, unchanged** (§11) |

**Not changed:** every server file, the API, the database schema, payouts, settlement, RNG, the proof verifier, wallet calculations, collision mapping, `package*.json`, the build and the hosting manifest. `public/app.js` is the only production file changed. No session identifier, credential or seed is exposed.

## 2. Starting checkpoint

| Check | Result |
| --- | --- |
| Remote | `origin` = `https://github.com/sarimichael/cargo-game` (fetch and push) |
| Remote refs after `git fetch origin --prune` | `claude/cargo-phase4a3-browser-consistency` = `d157909…`; its parent `9937de1…`; `main` = `13a98052aea654f1b58ee4be972c07ed2eda9adc`; no `claude/cargo-phase4a4-*` branch |
| Local | On `claude/cargo-phase4a3-browser-consistency` at `d157909`; clean index and working tree; no untracked files |
| New branch | `git checkout -b claude/cargo-phase4a4-ordering-correction d157909…` → HEAD `d157909`, parent `9937de1`, `main` an ancestor |

## 3. The blocking scenario (Codex), reproduced independently

Codex's reproduction files were in its own environment and were not used. The scenario was rebuilt from its description and then reproduced in `audit/browser-phase4a4.mjs`, scenario **C-01**:

1. Session **A**: a new visitor bets $30.00 on Easy. The page shows $970.00, revision 1, A's active round.
2. Session **B**: another client of the real API bets $3.00 on Hard: $997.00, revision 1, B's active round.
3. The cookie is switched to B, and the page's visibility synchronisation reads the session. The detection read gets B; `readSession()` sees an equal revision with different contents and sends the **confirmation read**. The server answers it with B, and its delivery is **held**.
4. The cookie is switched back to A.
5. The next **natural 12-second poll** gets unchanged A. It is accepted with **0 re-renders**, and $970.00 stays on screen.
6. The held confirmation (B) is delivered.

**Timing note.** The page abandons any request after 7 seconds, and polls are 12 seconds apart. The confirmation must still be pending when the newer poll is answered, so the detection read is sent about 3.5 s before the poll is due, and the confirmation is delivered within the limit. Each run asserts this, and asserts that exactly the three scripted reads were sent.

**C-02** repeats the scenario with two overlapping confirmations, released newest first.

## 4. Root cause

- `superseded(t)` is `t < appliedTicket || t < actionTicket`. In 4A.3, `appliedTicket` advanced in only three places: `commit()`, a successful action, and `quarantine()`.
- The poll calls `commit()` only when the read is a replacement, the revision changed, or the page is offline. An in-order poll that returns unchanged state therefore passed its own ordering check but **left `appliedTicket` behind**.
- The confirmation read was sent before that poll, so its ticket is lower. `appliedTicket` was lower still, so the confirmation was not superseded.
- When it arrived, `readSession()` compared B with A on screen, flagged a replacement, and returned it. The caller (`sync()` here; the poll in the poll-detected variant) committed it.
- The page then showed B while the cookie named A. **Sail** sent B's round ID with A's cookie, and the server answered 404 "Voyage not found.".

**Asynchronous gap, evaluated.** `readSession()` performs the ordering check, but the caller applies the read only after resuming from at least one `await`. On the confirmation path there are more hops, because an async function returns another promise. Everything between check and application runs as microtasks of the same task. Another read can only run in between if its response settles in that same task, so this could not be produced deterministically in a browser. It is nonetheless a real gap in the logic: there, an older read could overwrite a newer one. It is closed by repeating the check where the state is replaced (§5). This part is defence in depth; **no failing test demonstrates it.**

## 5. Correction (`public/app.js` only)

```diff
  if(superseded(t))return null;
+ appliedTicket=t; // accepted, whether or not the caller re-renders
  const replaced=…;
…
 function commit({t,next,replaced}){
+ if(superseded(t))return false;
  appliedTicket=t;data=next;…
+ return true;
 }
-async function sync(){const read=await readSession();if(!read)return false;commit(read);render();return true;}
+async function sync(){const read=await readSession();if(!read||!commit(read))return false;render();return true;}
…poll…
-if(read&&(…)){commit(read);render();…}
+if(read&&(…)&&commit(read)){render();…}
```

1. **Every accepted read advances the watermark.** A read that passes its ordering check sets `appliedTicket` to its own ticket, whether or not anything is re-rendered. A newer unchanged poll therefore supersedes every older read, including a pending confirmation. The poll still neither commits nor renders when nothing changed.
2. **`commit()` checks again where it applies.** It replaces `data` only if nothing newer has been accepted since the read was checked, and reports whether it did. `sync()` and the poll render only when it did.

`superseded()` and `quarantine()` are unchanged. Comments were updated; the production diff is +11/−4 lines (`git diff --stat`).

## 6. Why the ordering remains safe

- **A single, monotonic watermark.** `appliedTicket` is now the ticket of the newest accepted response: a read, a successful action, or a quarantine. It never decreases:
  - a read sets it only after passing `t >= appliedTicket`;
  - `commit()` sets it only after re-checking;
  - an action sets it to its own ticket, and no read is sent while an action is outstanding;
  - `quarantine()` takes a new, highest ticket.
- **Effect on each kind of request:**

| Request | Before 4A.4 | After 4A.4 |
| --- | --- | --- |
| Read older than a newer accepted **unchanged** read (including a pending confirmation) | Still eligible (the defect) | Ignored, on success and failure |
| Read older than a newer **committed** read, action, start or quarantine | Ignored | Ignored (unchanged) |
| Confirmation of a detection read that nothing newer has overtaken | Applied after one confirmation | Applied after one confirmation (unchanged; G-01) |
| Read sent after a quarantine (Try again, Load, the read after a start) | Eligible | Eligible (unchanged; G-03, 4A.3 suite) |
| Unchanged poll | No commit, no render, no notice | No commit, no render, no notice; only the watermark moves (C-01, G-02) |
| Higher-revision poll of the same session | Committed, "Voyage synchronized." | Unchanged (G-02) |
| Action result | Applied | Applied (unchanged; actions are not checked against reads) |

- **What is given up.** If an older read's answer would have carried newer server state (the network reordered it), it is now discarded once a newer read has been accepted, even an unchanged one. The page catches up at the next read: the next poll, at most 12 s later, or the player's next action, which the server checks itself. This applies the existing rule ("request order decides") to the one case it previously missed. A late 404 behaves the same way: the next read or action reports it, and an action on a missing session gets its own genuine 404 and quarantines at once.
- **Server authority unchanged.** The client still only chooses which received server snapshot to display. Every action is still checked by the server against the session revision and round.

## 7. Red-baseline reproduction (unmodified `d157909`)

**Method.**
1. `git worktree add --detach <scratch>/base-4a3 d157909…`, which reports HEAD `d157909` and an empty `git status`.
2. Before any production change:

```
PLAYWRIGHT_MODULE=… node audit/browser-phase4a4.mjs --root <scratch>/base-4a3 --out audit/results/phase4a4-red-baseline.json
```

The file records `rootHead` `d157909…`, no uncommitted changes, and the tested `public/app.js` SHA-256 `285a90c3…446e` (the 4A.3 file). Node 24.21.0, Chromium 141.0.7390.37.

**Result: 12/20 pass, 8/20 fail.**
- The 8 failures are C-01 and C-02 on both adapters and both viewports.
- Every failing run fails exactly the 5 intended assertions, with **0** setup, validity, console or timeout failures.
- The 12 passes are the guards G-01 to G-03, which are designed to pass before and after the fix.

| Assertion (C-01 and C-02; local and Worker; desktop and phone) | Recorded on `d157909` |
| --- | --- |
| Setup: A and B separate, both revision 1, 97,000 ¢ and 99,700 ¢, different rounds | pass |
| Detection read and confirmation (both 200), confirmation held; A still shown | pass |
| Newer natural poll (11.9–12.0 s after the reload) returns unchanged A: 0 re-renders, $970.00, no notice | pass |
| Validity: exactly the scripted reads; confirmation within the 7 s limit | pass |
| A remains displayed: balance $970.00 | **fail: "$997.00"** |
| A's round, difficulty and stake remain | **fail: B's round, "hard", "3.00"** |
| No replacement or synchronisation notice | **fail: "This browser is now using a different demo session…"** |
| B's $997.00 never displayed | **fail** |
| Sail advances A's own round with no 404 | **fail: `POST /api/rounds/:id/advance 404`; A step 0, revision 1** |
| Session B unchanged on the server | pass (B step 0, revision 1, 99,700 ¢) |

## 8. Green results (this branch)

**Corrected client** (`public/app.js` SHA-256 `28a3dfb03f860d598c9626e6bdb49c0276cd4dd60a7bbc12d9b7ea9753fabc18`). `audit/browser-phase4a4.mjs` passes **20/20**: C-01, C-02 and G-01 to G-03, on the local server and the Worker, desktop and phone. Committed evidence: `audit/results/browser-phase4a4.json`, from the final Node 24 full `run-all`.

| Run | Node 24.21.0 | Node 22.22.0 |
| --- | --- | --- |
| Exploratory, during development | 20/20 (1 run) | — |
| Standalone | 20/20 (2 runs) | 20/20 (1 run) |
| Inside `run-all` | 20/20 (2 full runs) | 20/20 (2 `--quick` runs) |

In every corrected C-01 and C-02 run, the same checks that failed on `d157909` pass:
- after the stale confirmation(s), the page still shows **$970.00** with A's round, Easy, $30.00 and **Sail to stop 01**;
- no replacement notice appears, and $997.00 is never displayed;
- **Sail** advances A's own round (server: A step 1, revision 2) with no 404;
- B is unchanged (step 0, revision 1, 99,700 ¢).

| Viewport | Local server | Worker (node:sqlite D1) |
| --- | --- | --- |
| Desktop 1440×900 | C-01, C-02, G-01, G-02, G-03 pass | C-01, C-02, G-01, G-02, G-03 pass |
| Phone 390×844 (`isMobile`, touch) | C-01, C-02, G-01, G-02, G-03 pass | C-01, C-02, G-01, G-02, G-03 pass |

**Guards (pass before and after):**
- **G-01:** equal-revision replacement B is shown with its notice, and Sail acts on B. A lower-revision replacement (a new session) is shown with its notice.
- **G-02:** an unchanged poll causes 0 re-renders and keeps the typed bet "45.67" and the focus. A same-session refill is shown as "Voyage synchronized.", with the typed bet and focus kept.
- **G-03:** after a genuine removal and a 404, the newest outstanding read's late success does not restore A. The recovery control stays, and one explicit start creates one session.

## 9. Deterministic repair of `audit/tests/phase4a3.test.js`

- **Defect.** The test played exactly two voyages, Easy then Expert. Each voyage was 2–5 actions depending on random losses, and the test then asserted `compared >= 10`. Legitimate early settlement could leave 8 or 9.
- **Baseline.** 1,000 runs of the unmodified 4A.3 file, with `node --test audit/tests/phase4a3.test.js`, Node 24.21.0 and a fresh process per run: **994 pass, 6 fail**. All six failures were this assertion, with "compared 8 states" or "compared 9 states", 3 on each adapter (runs 154, 449, 510, 546, 616, 740). No equality assertion failed.
- **Repair.** The count is replaced by a coverage rule based on what actually happened:
  - **Every kind compared at least once.** Each kind of state change (bet, sail, single collection, collection of all remaining cargo, refill, replay, first read) must be compared at least once.
  - **Two settled voyages.** At least two voyages (one Easy, one Expert with an uneven split) must be settled in the history.
  - **More voyages if needed.** Voyages, alternating Easy and Expert, continue until the collection kinds have occurred, up to 40.
- **Unchanged.** The equality assertions are identical. No outcome is forced, and the game's randomness, payouts and hazard rules are untouched.
- **Why coverage is guaranteed:**
  - **Every voyage:** bets and sails happen in every voyage, and the refill, replay and first read happen in every run.
  - **Easy voyages:** only the two collection kinds depend on surviving cargo. Easy has independent decks and loss chances of 1/20 then 1/19, so a voyage provides both kinds with probability 1 − (0.000125 + 0.007125 + 0.135375/19 + 0.857375/361) ≈ 0.98325.
  - **Failure bound:** among the 40 voyages allowed, 20 are Easy, so the test can fail only if all 20 miss, with probability below 0.01675²⁰ ≈ 3×10⁻³⁶. Expert voyages only add chances.
  - **No fixed count left:** early settlement leads to another voyage, never to a failed count.
- **After repair.** 1,000 runs, same command: **1,000 pass, 0 fail.** The test file's other three tests (the comparison is taken from `public/app.js`, and two sessions at equal revisions compare different) are unchanged.

## 10. Complete regression results

**Environment:**
- Linux 6.18.44 x86_64 cloud container.
- **Node 24.21.0** with **npm 11.19.0**: the official tarball, SHA-256 checked, in a scratch directory and not committed.
- **Node 22.22.0** with **npm 10.9.4** (system).
- Playwright 1.56.1 with **Chromium 141.0.7390.37**.
- Reduced motion on. Desktop 1440×900; phone 390×844 with `isMobile` and touch.

| Suite or command | Node 24.21.0 | Node 22.22.0 |
| --- | --- | --- |
| `browser-phase4a4.mjs --root <worktree of d157909>` (red baseline) | **12/20, FAIL as expected** (`audit/results/phase4a4-red-baseline.json`) | — |
| `browser-phase4a4.mjs` (corrected) | **20/20** in 5 runs | **20/20** in 3 runs |
| `browser-phase4a3.mjs` (4A.3 suite: M-01, M-02, desktop and phone) | **14/14** in 2 `run-all` runs | **14/14** in 2 `run-all --quick` runs |
| `browser-phase4a2.mjs` (4A.2 suite: M1–M3) | **12/12** in 2 `run-all` runs | **12/12** in 2 standalone runs and 1 `run-all --quick` run; see the anomaly below for the other |
| `browser-check.mjs` (original suite) | **6/6** in 2 `run-all` runs | **6/6** in 2 `run-all --quick` runs |
| `node --test audit/tests/*.test.js` | **116/116** pass, 0 fail, 0 skipped, 0 todo | **116/116** pass, 0 fail, 0 skipped |
| `npm test` | **12/12** | **12/12** |
| `npm run test:hosted` | pass | pass |
| `npm run test:collisions` | pass | pass |
| Exact maths / RNG | 13/13; 8/8 with 108 known-answer vectors | same |
| Simulation statistics | 107 p-values, 0 Bonferroni rejections, 0 invalid decks | same |
| System / adversarial (`validate-system.mjs`) | 21/21 | 21/21 |
| Storage (F03) and save-folder lock stress (F07) | F03 measured; lock stress 6+6 rounds, 0 lost while held, 0 wrongly acquired | skipped in `--quick` by design |
| `node audit/run-all.mjs` | **ALL PASSED**, twice (full); the second run produced the committed results | `--quick`: **1 of 2 runs ALL PASSED**; the other failed on the cleanup anomaly below |
| `npm ci && npm run build` | **Build OK**; `dist/client/app.js` is byte-identical to `public/app.js` | — |
| `phase4a3.test.js` repeated (§9) | Old: 994/1,000; repaired: **1,000/1,000** | — |

**Production integrity** (every `run-all`):
- 42 production files compared; 0 unexpected changes;
- 0 protected files changed (`server/fairness.js`, `server/game.js`, `public/collision.js`, `db/schema.ts`, `.openai/hosting.json`);
- 0 payout, settlement, RNG, proof or collision changes since `fca90c6`.

**Not failures:**
- **Claim cross-check.** It reports the same 2 known rounding mismatches as on every earlier base (N04), and exits 0 by design.
- **Characterisation tests.** 14 of the 116 regression tests are "KNOWN DEFECT" tests (F01 ×2, F03, F05 ×2, F09 ×4, F11 ×3, L1 ×2), and 3 system checks are of type `defect` (S14 F01/F09, S16 F05, S19 F11). They **pass because the defects still reproduce.** None is fixed.

**Anomalies:**
- **Node 22 `run-all --quick` cleanup race (pre-existing, not changed).** The first Node 22 `run-all --quick` exited 1. Its `browser-phase4a2.mjs` step threw `ENOTEMPTY` (`rmdir /tmp/cargo-browser-4a2-…`) while deleting its temporary data directory.
  - **Cause, from the code:** `audit/browser-phase4a2.mjs:209` calls `server.kill()` and then `fs.rmSync(dataDir)` at once. The server is exiting, and its lock release renames and removes files in that same directory (`server/lock.js:82-83`), so the directory can gain an entry while it is being deleted.
  - **Why it is not a scenario failure:** the failure happens after the scenarios. `run-all` keeps only each step's last six lines, so that run's scenario lines were not recorded. Two standalone Node 22 runs of the same script then passed 12/12, with every scenario line recorded, and a second `run-all --quick` passed.
  - **Not fixed:** changing that script is outside this phase's authorisation (one test assertion). It is reported for a separate decision.
- **`npm ci` (npm 11.19.0)** again reported that esbuild's `postinstall` was not run. The build completed, and no dependency or lockfile changed.
- No browser scenario failed nondeterministically in any recorded run. All timing windows are asserted by validity checks.

## 11. Known limitations and unresolved risks

| Item | Status |
| --- | --- |
| **Session-start timeout classification** (Codex, Medium, pre-existing) | **Out of scope, unchanged, still a tracked risk.** Codex reproduced it; I did not exercise it in a browser. The likely mechanism, from the code and checked in Node only: a fetch that hits the page's 7 s `AbortSignal.timeout` rejects with a `DOMException` named `TimeoutError`, whose legacy numeric `code` is 23. `startNewSession()` treats any truthy `e.code` as "the server answered: nothing was started" and re-enables **Start**. A start whose outcome is unknown can therefore be classified as definitely failed, and a second start could create an extra session. The fix belongs with R5 |
| **R5** server-side idempotency of `POST /api/session` | **DEFERRED**, unchanged |
| **F11, F03, F09, F05, F01, L1** and others | Unchanged. Their characterisation tests and `defect` system checks still pass **because the defects still reproduce** (§10). None is fixed |
| Poll-detected variant | C-01 and C-02 detect B with a visibility read. A variant in which a poll detects B and the next poll overtakes the confirmation is not exercised. The two polls are 12 s apart and requests are abandoned after 7 s, so that ordering needs the first poll's answer itself delayed 5–7 s. It goes through the same `readSession()`/`commit()` code; only the caller receiving `null` differs |
| Microtask gap | Closed by the re-check in `commit()`; no failing test demonstrates it (§4) |
| Freshness trade-off | A late answer to an older read is ignored once a newer read is accepted (§6) |
| Higher-revision replacement wording | Still announced as "Voyage synchronized."; display correct (unchanged from 4A.3) |
| Old round visuals while quarantined | Unchanged from 4A.2 and 4A.3 |
| Worker coverage | Runs `server/worker.js` on the audit harness's node:sqlite D1 stand-in behind an HTTP bridge. It does not run the Cloudflare runtime and is not a production deployment |
| Platforms | Chromium only. Firefox, WebKit and real devices were not run |
| Live site | **Not deployed.** The phone link still serves the previously published version |

## 12. Files changed (relative to `d157909`)

| File | Change |
| --- | --- |
| `public/app.js` | Accepted reads advance `appliedTicket`; `commit()` re-checks and reports; `sync()` and the poll render only after a successful commit; comments |
| `audit/browser-phase4a4.mjs` | **New** browser regression suite: C-01, C-02 and G-01 to G-03; local and Worker; desktop and phone; `--root` |
| `audit/tests/phase4a3.test.js` | Coverage rule made independent of random voyage length; equality assertions unchanged |
| `audit/results/phase4a4-red-baseline.json`, `browser-phase4a4.json` | **New** evidence: red baseline on `d157909`, corrected run |
| `audit/run-all.mjs`, `audit/README.md` | Run and document the new suite; integrity lists unchanged |
| `docs/API.md` | Read-ordering rule: an accepted read supersedes older pending reads even when nothing changes |
| `CARGO_PHASE4A3_CORRECTION_REPORT.md` | Phase 4A.4 correction notice and **[4A.4]** markers; original text kept |
| `CARGO_PHASE4A4_CORRECTION_REPORT.md` | This report |
| `audit/results/*` (others) | Regenerated by the final Node 24 full `run-all`. `math.json`, `rng.json`, `claims.json`, `simulation.json`, `lock-stress.json` and `browser.json` differ only in timestamps and timings; `browser-phase4a2.json` also in random round IDs. `browser-phase4a3.json` also in run metadata (`rootHead`, uncommitted files, the tested `public/app.js` hash, now the 4A.4 file) and random voyage outcomes. `system.json` and `storage.json` also differ in outcome counts and byte measurements (unseeded by design; 21/21 pass). `manifest.json`: new hashes, durations and steps |

**Evidence integrity:**
- **Red baseline:** `phase4a4-red-baseline.json` records `rootHead` `d157909…`, an empty uncommitted list, and `public/app.js` `285a90c3…446e`.
- **Corrected run:** `browser-phase4a4.json` records `rootHead` `d157909…` with the working-tree changes listed, because it was produced before the commit, and `public/app.js` `28a3dfb0…bc18`, the committed file.
- **Server files:** both runs record the same hashes, because they did not change: `server/app.js` `0fdba910…`, `server/worker.js` `3d92e74c…`, `server/store.js` `7fdf4f20…`, `server/game.js` `c2bde58a…`.

## 13. Recommendation

**Ready for Technical Lead review of the local commit.** It has not been pushed and has not been independently reviewed. Publication and Codex validation need separate approval.

Suggested review order:
1. `public/app.js`: `readSession()`, `commit()`, `sync()` and the poll, against every caller and the table in §6.
2. Re-run the red baseline: `node audit/browser-phase4a4.mjs --root <checkout of d157909>`.
3. The repaired coverage rule in `audit/tests/phase4a3.test.js` (§9).
