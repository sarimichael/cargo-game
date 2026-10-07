# Cargo independent validation report

**Date:** 7 October 2026
**Branch:** `claude/cargo-rtp-model-progress-jtepzy`
**Code under test:** production files byte-identical to `25d5181` (verified by `audit/run-all.mjs`)
**Runtime:** Node.js v24.21.0, Linux x64, 4 vCPU

This is an independent re-validation of `CARGO_SAYCOVE_AUDIT.md`. It is an audit of correctness and consistency only. It does not optimise payouts, retention or operator revenue, and it is not a laboratory certification. Every number below was produced by a script in `audit/`, and the corresponding JSON in `audit/results/` is committed. Nothing here is copied from the earlier audit without being recomputed.

## 1. Overall result

| Area | Checks | Result |
| --- | --- | --- |
| Exact mathematics (`validate-math.mjs`) | 13 | **13/13 pass.** One specification ambiguity found (N03) |
| Audit claim cross-check (`validate-claims.mjs`) | 250 claims | **169 reproduced exactly; 69 simulation rows internally consistent; 10 unverifiable; 2 rounding mismatches in the audit's headline text** |
| RNG structure (`validate-rng.mjs`) | 8 | **8/8 pass** |
| Simulation, 4,000,000 rounds (`simulate.mjs` + `analyze-simulation.mjs`) | 107 statistical screens | **0 invalid decks; 0 of 120,000 sampled decks differ from the reference; 0 Bonferroni rejections; results agree with theory** |
| System and adversarial, both adapters (`validate-system.mjs`) | 21 | **12/12 safety properties hold; 7/7 reported defects reproduce; 2 observations** |
| Regression tests (`node --test audit/tests/*.test.js`) | 36 | **36/36 pass** (14 characterise known defects) |
| Existing project tests | 3 commands | **All pass** (`npm test` 12/12, `test:hosted`, `test:collisions`); `npm run build` passes |

**Bottom line.** The implemented mathematics and RNG behave as documented. Under assumption A1 (below), no non-anticipating strategy reaches 100% RTP: the exact maximum is 98.738739%. The audit's mathematical tables are accurate to their printed precision. Every safety property the audit reported as holding still holds, and every defect it reported still reproduces. Four new issues were found (N01–N04), all LOW or informational. The audit's verdict, **not ready for real-money integration**, stands.

## 2. Method and assumptions

- **Independence from production code.** Reference implementations of the stake split, payout rounding, survival probabilities and the hazard-deck algorithm (`audit/lib/exact.mjs`, `audit/lib/reference-rng.mjs`) were written from `docs/FAIRNESS.md` and do not import production code. Production functions are then compared against them.
- **Exact arithmetic.** All mathematical pass/fail decisions use BigInt rationals. Floating point is used only for display and for statistical screens.
- **Determinism.** Mathematics, claims, RNG, simulation and engine-level tests use seeds `SHA-256("cargo-audit-v1|label|i")` and reproduce identical outcomes. The HTTP/Worker system checks (S01–S21) create sessions through production `newSeed()`, which cannot be injected without changing production code. Their game outcomes vary between runs (for example, the F03 limit was reached after 922 rounds in one run and 921 in the recorded run), but every assertion holds for any outcome. Counts quoted below come from the recorded run in `audit/results/system.json`.
- **Assumption A1.** Treat HMAC-SHA-256 outputs as uniform and independent. This is the standard cryptographic assumption. It is not proved by any finite test.
- **Assumption A2.** Treat derived SHA-256 seeds as equivalent to OS-random seeds for testing the seed → deck mapping. Host entropy is **not** tested.
- **Assumption A3.** The worker tests use an in-memory `node:sqlite` stand-in for Cloudflare D1, including an emulated 2,000,000-byte row limit. Real D1 behaviour (latency, replication, failover) is **not** reproduced.
- **Fault injection.** This lives only in test doubles: the SQLite stand-in, a one-shot override of `fs.writeFileSync` inside the test process, and test-only writes that force hazard decks in stored state. Forced decks are never used where a proof is verified.

## 3. Mathematical fairness audit (M01–M13)

| ID | Check | Result |
| --- | --- | --- |
| M01 | Configuration matches docs (hazards 1/3/5/10, stops 19/17/15/10 = 61, limits $3–$3,000, $1,000 start) | Pass |
| M02 | Enumerate all 201,420 hazard subsets; survival counts equal C(20−s,h) at every stop | Pass, 0 mismatches |
| M03 | p_s = h/(21−s) compounds exactly to S_s; `nextRisk()` equals it (≤1e-15); 0 at the final port | Pass |
| M04 | All 61 multipliers equal round-half-up(98/S_s) computed exactly | Pass. **2 exact ties found** (N03) |
| M05 | `splitStake` over all 299,701 wagers vs BigInt reference: conserved, spread ≤1¢ | Pass |
| M06 | `payout` over all 6,093,961 stake × multiplier pairs vs BigInt | Pass. Largest product 1,810,608,800,000 is about 4,974× below 2^53 |
| M07 | Per-stop odds, nominal RTP and exhaustive cent-RTP range (61 stops × 299,701 wagers, exact) | Pass. 22 stops above 98% nominal, 12 below, 27 exactly 98% |
| M08 | Exhaustive optimal stopping over every wager | Pass. Maximum is **548/555 = 98.738739%** (Easy, $3.33, stops 4/4/4) |
| M09 | Joint three-container Bellman program (every state and collectable subset) vs factorised optimum, 48 mode/wager cases | Pass. **Exactly equal** in all 48 |
| M10 | $30 strategy comparison (6 strategies × 4 modes) | Matches audit §6 |
| M11 | Exposure: max $543,182,640 gross per round (Expert, $3,000), no cap | Matches audit §4 |
| M12 | Final-stop variance m²S(1−S)/3 | Matches audit §8 |
| M13 | Every deviation from 98% is within the theoretical rounding bounds (≤0.005·S from multiplier rounding; ≤S/200 from cent rounding) | Pass |

**Maximum achievable RTP by mode** (exact, all wagers and all non-anticipating strategies):

| Mode | Best wager | Targets | Max RTP | Exact | Lowest optimum over wagers |
| --- | --- | --- | --- | --- | --- |
| Easy | $3.33 | 4/4/4 | 98.738739% | 548/555 | 98.181818% ($3.30) |
| Medium | $3.36 | 5/5/5 | 98.355263% | 299/304 | 98.245614% ($3.00) |
| Hard | $3.15 | 1/1/1 | 98.571429% | 69/70 | 98.060545% ($3.03) |
| Expert | $3.36 | 1/1/1 | 98.214286% | 55/56 | 98.000185% ($3.51) |

The range of cent-rounded RTP across all wagers and stops runs from 97.378641% (Easy stop 3 / Medium stop 1 at $3.09) to 98.738739%. Every value is below 100%.

### Do rounding, published calculations and implementation agree?

- **Published tables vs implementation.** All 122 rows of the §4 odds and payout tables, the exposure table, the maximum-RTP table, the strategy table and the worked examples match exactly to their printed precision (see `results/claims.json`).
- **Rounding.** Payout rounding is exact half-up in integer cents with no floating point, and no money is created or lost when splitting stakes. The only rounding discrepancies found are:
  - **N03 (spec ambiguity).** 98/S is exactly 122.5 at Easy stop 4 and exactly 199.5 at Medium stop 4. `docs/FAIRNESS.md` says only "round(0.98/survival, 2)". The table uses half-up (1.23×, 2.00×). A half-even implementation, which is the default in Python, NumPy and .NET, would produce **1.22×** at Easy stop 4. That would change the nominal RTP at that stop from 98.4% to 97.6%, and that stop is where the global maximum RTP occurs. Medium stop 4 gives 2.00× under both rules. The existing `test/game.test.js` happens to agree only because JavaScript's `Math.round` rounds .5 upward.
  - **Audit text (N04).** §1 and §10 print the maximum as "98.738738%" and the house edge as "1.261262%". The exact values 548/555 and 7/555 round to **98.738739%** and **1.261261%**, as the audit's own §6 table shows.
- **Different valid inputs.** Uneven cent splits ($3.01, $3.02) lead to different optimal targets per container. This is a legitimate rounding effect, reproduced exactly (98.421927% and 98.443709%). It is not information leaking between containers.

## 4. RNG implementation review (R01–R08)

| ID | Check | Result |
| --- | --- | --- |
| R01 | Production `hazardDeck()` vs spec-only re-implementation: 14,400 decks, 8 stress client seeds (128 chars, JSON metacharacters, emoji, combining marks, RTL, unpaired surrogate, whitespace) | **0 mismatches** |
| R02 | Browser Web Crypto verifier (`public/fairness.js`) on 192 real engine rounds with stress seeds | **192/192 valid** |
| R03 | Rejection sampling for bounds 2–20: limit divisible by b, rejected tail < b, equal preimages; forced 0xFFFFFFFF is rejected and consumes one extra draw | Pass. Natural rejection probability is ≈1.6×10⁻⁸ per deck, so this path is exercised only with forced input |
| R04 | The implemented Fisher–Yates loop is a bijection from draw sequences to permutations (n = 1…8, 40,320 sequences at n = 8); h-prefix sets are equally weighted | Pass |
| R05 | HMAC message is the documented JSON array; 216 distinct messages; separator injection cannot collide; unpaired surrogates escaped identically for Node and browser | Pass |
| R06 | Commitment is SHA-256 of the raw seed bytes (not the hex text); 10,000 `newSeed()` values have 64-hex format and are unique | Pass |
| R07 | Difficulty is not in the HMAC message: Easy ⊂ Medium ⊂ Hard ⊂ Expert decks for the same inputs | Confirmed (observation, as audit §7). Safe only while one committed seed serves exactly one round with a locked difficulty |
| R08 | 3,369 active-round projections contain no server seed or hazards; all 400 settled rounds reveal them | Pass |

`audit/results/rng-vectors.json` pins 108 known-answer decks, so any change to RNG behaviour fails `audit/tests/rng.test.js`.

**Conclusion.** Outcome generation follows the documented methodology exactly. Within assumption A1, the shuffle is unbiased and the three container streams are domain-separated.

## 5. State machine, input validation, security boundaries and error handling (S01–S21)

All checks run against the **real** `server/app.js` (HTTP) and `server/worker.js` (fetch handler) unless marked "engine".

| ID | Type | Check | Local | Worker |
| --- | --- | --- | --- | --- |
| S01 | safety | 20 identical concurrent bets → 1 debit, 19 replays | ✔ | ✔ |
| S02 | safety | 20 distinct bets at the same revision → exactly 1 succeeds | ✔ | ✔ |
| S03 | safety | 20 identical concurrent advances → one stop | ✔ | ✔ |
| S04 | safety | 50 identical collect-all → exactly 3 credits, exact amounts | ✔ | ✔ |
| S05 | safety | Cash-out vs eliminating advance, 40 races each: one wins, never both (20/20 split) | ✔ | ✔ |
| S06 | safety | Forged multiplier, payout, balance, hazards, step, status, seed and difficulty fields are ignored | ✔ | ✔ |
| S07 | safety | 28 malformed bets (types, bounds, `__proto__`/`constructor`/`toString` difficulties, seeds, stale commitment) rejected with no stored change | ✔ | ✔ |
| S08 | safety | 24 protocol cases return the documented status (400/401/403/404/409/413/415) | ✔ | ✔ |
| S09 | safety | 1,066 (local) and 910 (Worker) active-round responses, including replays, contain no seed or hazards | ✔ | ✔ |
| S10 | safety | 80-round mixed campaign: ledger reconciles, every credit = payout(stake, M at collect), 80/80 proofs verify per adapter, iceberg/debris mapping matches server outcomes (recorded run: 57 icebergs, 187 debris) | ✔ | ✔ |
| S11 | safety | Socket destroyed right after sending a bet; exact retry → one debit (10 trials) | ✔ | n/a |
| S12 | safety | Storage failure before commit → 500 with no change; failure after commit → 500, then exact retry is replayed with no second effect | ✔ | ✔ |
| S13 | defect F10 | actionId `constructor` → false 409; reordered JSON keys → false 409 (no duplicate credit) | reproduced | reproduced |
| S14 | defect F01/F09 | Reset restores $1,000 after a loss; 25 cookieless GETs create 25 funded sessions | reproduced | reproduced |
| S15 | defect F03 | Natural growth: after 921 minimum-stake rounds the session reached 1,999,705 bytes and the next write (a bet) failed with 500, freezing the wallet. Boundary fixture: when a bet is the last write that fits, advance and collect return 500 and the paid wager stays active with no credit. Local store grows ≈2,184 bytes per round | — | reproduced |
| S16 | defect F05 | All modes: at the final port, advance → 409; round stays active and uncredited until collect | reproduced | reproduced |
| S17 | defect F07 | Two `Store` instances: an acknowledged −100¢ debit is overwritten by a stale writer | reproduced (engine) | — |
| S18 | defect F08 | `verifyRound` accepts altered algorithm, multiplier100, id, valueCents, nextRisk, maxStops, timestamps **and duplicate container entries**; rejects altered totals | reproduced (engine) | — |
| S19 | defect F11 | Table changed 1.03×→1.04× mid-round: accepted wager paid 104¢ instead of 103¢; rounds store no math version | reproduced (engine) | — |
| S20 | observation → **N01** | Body split mid-character: local stores `ship-���-cargo` instead of `ship-🚢-cargo`; Worker intact | **defect** | ✔ |
| S21 | observation → N04 | "Refill" sets the balance to $1,000 even when higher (−90¢ entry); a refill at exactly $1,000 writes a 0¢ ledger entry | observed | observed |

## 6. Simulation (unmodified production `hazardDeck()`)

**Method.** 1,000,000 rounds per mode (3,000,000 container routes per mode; 12,000,000 in total) through the unmodified `hazardDeck()`. Round *i* uses server seed SHA-256("cargo-audit-v1|sim|mode|i"), client seed `audit-sim-mode` and nonce *i*. Each route was evaluated at every permitted stop. Returns use a $30 wager ($10 per container), where cent rounding is exact. Every 100th round was also generated by the reference implementation. The run took 1,277 s on 4 worker threads (20:48–21:10 UTC). Results are independent of thread count (verified with 1 vs 3 threads), and the per-mode `streamHash` identifies the exact sample:

| Mode | Stream hash (SHA-256 of all decks, in order) |
| --- | --- |
| Easy | `604fe8d44eafe336a2fa016fa0929d905d14e09f8fa25966b20078b049d7ee7a` |
| Medium | `5142c905181c171f87152ed646d142b3d0662eea69bc2b99768b0ce99309fd00` |
| Hard | `c405951acf9a887ba701337b74c144ad9ff394478f055180807ee883d194928b` |
| Expert | `7b5a17c5f486bb46c3cef604c3d49d71e33df5102033d23f2cfb78c44adbe61e` |

**Integrity.** 0 invalid decks (wrong size, duplicates, out of range or unsorted) in 12,000,000. 0 mismatches in 120,000 decks cross-checked against the reference implementation.

**Returns vs theory** (z uses the theoretical standard error):

| Mode | First stop: sample / theory (z) | Final stop: survivors obs / exp | Final stop: sample RTP, 95% Wilson | Theory | Max \|z\| over all stops |
| --- | --- | --- | --- | --- | --- |
| Easy | 97.85371% / 97.85% (+0.29) | 149,675 / 150,000 | 97.788% [97.306, 98.272] | 98% | 1.67 |
| Medium | 97.76625% / 97.75% (+0.69) | 2,759 / 2,631.6 | 102.745% [98.984, 106.649] | 98% | 2.49 |
| Hard | 98.15874% / 98.25% (−2.79) | 171 / 193.5 | 86.605% [74.561, 100.595] | 98% | 2.79 |
| Expert | 97.95936% / 98% (−0.72) | 19 / 16.2 | 114.672% [73.415, 179.113] | 98% | 1.54 |

Two of the 61 per-stop rows exceed |z| = 1.96: Medium stop 17 (+2.49) and Hard stop 1 (−2.79). About three are expected at the 95% level. Stops within a mode reuse the same routes, so neighbouring rows are correlated. The final-stop tails are extremely noisy: one Expert survivor moves that row's RTP by about six percentage points. These samples therefore confirm the mechanism, not the tail RTP, which rests on the exact mathematics (§3).

**RNG screens** (p-values; chi-square unless noted):

| Mode | Positions A/B/C | First hazard A/B/C | Independence AB/AC/BC | Whole deck | Lag-1 r (z) | Adjacent repeats obs/exp |
| --- | --- | --- | --- | --- | --- | --- |
| Easy | 0.808 / 0.241 / 0.466 | 0.808 / 0.241 / 0.466 | 0.046 / 0.950 / 0.978 (df 361) | 0.579 (20 cells) | −0.00029 (−0.29) | 50,344 / 49,999 |
| Medium | 0.574 / 0.944 / 0.698 | 0.724 / 0.225 / 0.559 | 0.252 / 0.815 / 0.928 (df 256) | 0.291 (1,140 cells) | 0.00013 (+0.13) | 897 / 877.2 |
| Hard | 0.834 / 0.526 / 0.663 | 0.441 / 0.435 / 0.634 | 0.504 / 0.997 / 0.067 (df 144) | n/a | 0.00063 (+0.63) | 64 / 64.5 |
| Expert | 0.990 / 0.976 / 0.690 | 0.743 / 0.194 / 0.188 | 0.752 / 0.827 / 0.849 (df 36) | n/a | −0.00097 (−0.97) | 3 / 5.4 |

For Easy, "positions" and "first hazard" are the same statistic, because one hazard is both. Independence tables bin rare first-hazard positions so that every expected cell is ≥ 12.

**Multiple comparisons.** Across 107 p-values the minimum is 0.0053 (Hard stop-1 survival). One falls below 0.01 (1.07 expected by chance) and none below 0.001. There are **0 rejections** at the Bonferroni threshold of 4.67×10⁻⁴.

**Conclusion.** No evidence of bias, cross-container dependence or serial correlation in the production RNG at this sample size. The audit's §8 conclusions are confirmed by an independent, reproducible sample. This is a diagnostic screen, not a certification battery (for example, TestU01 or NIST SP 800-22 were not run).

## 7. Outstanding defects and uncertainties

### Defects (none fixed; production code unchanged)

| ID | Severity | Status | Summary | Tracking test |
| --- | --- | --- | --- | --- |
| F01 | HIGH | Reproduced | Free play-money creation/refill; no real-money launch boundary | `known-defects` F01 |
| F02 | HIGH | Confirmed by inspection | No external wallet debit/credit/rollback/reconciliation lifecycle | n/a (absent capability) |
| F03 | HIGH | Reproduced | Unbounded session JSON hits the D1 row limit and blocks settlement | `known-defects` F03, `system` S15 |
| F04 | HIGH | Confirmed exactly | $543,182,640 maximum round exposure; no cap or reserve control | `math.test.js` |
| F05 | HIGH | Reproduced | Final-port survivors uncredited until explicit collect; recovery tied to anonymous cookie | `known-defects` F05 |
| F06 | MEDIUM | Confirmed exactly | RTP varies by stop, wager and strategy (97.378641%–98.738739%) | `math.test.js` |
| F07 | HIGH | Reproduced | Local file store loses updates across processes | `known-defects` F07 |
| F08 | MEDIUM | Reproduced, **broader than reported** | Verifier accepts altered metadata, including duplicated containers | `known-defects` F08 |
| F09 | MEDIUM | Reproduced | No session expiry, quotas or rate limits | `known-defects` F09 |
| F10 | LOW | Reproduced | `constructor` actionId and key-order false conflicts | `known-defects` F10 |
| F11 | HIGH | Reproduced | Round math not pinned at wager time | `known-defects` F11 |
| **N01** | LOW | **New** | Local server (`server/app.js` `body()`) decodes each TCP chunk separately, so a multi-byte client seed split across chunks is silently replaced with U+FFFD. The round then commits to a seed the player did not choose, and a retry with different chunking gets a false 409. Fix: collect Buffers and decode once (as the Worker already does). Local adapter only; the server binds 127.0.0.1 | `known-defects` N01, `system` S20 |
| **N02** | LOW | **New** | `MODES` is frozen only at the top level; mode objects and payout arrays are mutable in-process. This enables F11-style drift from any in-process code | `known-defects` N02 |
| **N03** | LOW (spec) | **New** | Tie rule unspecified; Easy stop 4 (122.5) and Medium stop 4 (199.5) are exact ties. A half-even re-implementation pays 1.22× instead of 1.23× at Easy stop 4. Fix: state "half-up" explicitly in `docs/FAIRNESS.md` and test with exact rationals | `math.test.js` |
| **N04** | INFO | **New** | Documentation inconsistencies: audit §1/§10 headline rounding (98.738738% / 1.261262%); Node version stated as ≥24 (`package.json`, README) but `server/index.js` enforces ≥22, while `docs/TESTED.md` and the audit cite different Node 24 builds; "Refill" can lower a balance and writes 0¢ entries | n/a |

### Uncertainties and unverifiable items

1. **Original audit evidence.** The original harness scripts and JSON (`audit-*.mjs`, `audit-results/*.json`) are known only by hash. Their outputs cannot be compared with these.
2. **§8 random sample.** The audit's simulation counts cannot be reproduced, because the seeds were not retained. They are internally consistent (all 61 rows) and statistically compatible with theory; the new deterministic run (§6) replaces them as reproducible evidence.
3. **Browser evidence.** The audit's browser session ($3.01 split, captured traces, 100 browser-verified rounds) was not replayed in a browser. Verifier logic was exercised headlessly through `public/fairness.js` on Node's Web Crypto (R02, S10).
4. **Deployment and infrastructure.** The live private site, the deployed bundle's equivalence, real Cloudflare D1 limits, failover, durability, secrets, entropy health and gateway rate limits were **not verified**. The built `dist/server/index.js` was smoke-tested locally only.
5. **Rare tails.** Final-stop tails (Medium–Expert) are too rare for simulation to validate (an Expert ±1 pp RTP interval needs ≈2.27 billion rounds). Only the exact mathematics covers them.
6. **Cryptography.** No statistical test can prove CSPRNG security, absence of side channels, or that unrevealed seeds cannot leak through hosting access.
7. **Saycove compatibility.** There is no integration specification, so nothing protocol-specific was verified.
8. **96.8% RTP model.** No artefact exists. Building one requires a product decision on a new payout ladder, which changes payout configuration and is outside this audit's authority.

## 8. Reproduction

```sh
node audit/run-all.mjs             # ~2 min: all validators, regression tests and existing tests
node audit/run-all.mjs --simulate  # also regenerates the 4M-round simulation (~25 min on 4 cores)
```

`audit/results/manifest.json` records the Node version, Git HEAD, exit code of every step, the production-integrity comparison against `25d5181`, and SHA-256 of every audit script and result.
