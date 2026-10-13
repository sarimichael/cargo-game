# Build verification — 7 October 2026

## cargo-v2: exact 96.8% return — 13 October 2026

New bets use `cargo-v2` calibrated odds with the unchanged `ladder-v1` multipliers. Rounds keep the rules version they were accepted under; `cargo-v1` rounds and proofs keep their original rules. Checks ran on Node.js 22.22.0 (the project targets Node.js 24 or newer).

**Exact checks (proof basis).** `npm run test:rtp` passed. It used integer arithmetic over every container stake from 100 to 100,000 cents in all four modes (399,604 stakes, 6,093,961 stop checks) and every total wager from $3.00 to $3,000.00 in all four modes (1,198,804 wagers). Every fixed stop, the best stopping rule and the worst stopping rule return exactly 96.8%. Three deliberate defects were each detected: a survival numerator off by one, one changed multiplier, and a 122/125 target. The proof for adaptive and cross-round strategies is in [FAIRNESS.md](FAIRNESS.md).

**Automated suites.** `npm test` (18 groups), `npm run test:hosted` and `npm run test:collisions` passed. `npm ci` and `npm run build` succeeded. The unit tests include historical cargo-v1 proofs exported by the original engine; they still verify, and relabeling them as cargo-v2 fails.

**Simulations (illustration only, not proof).** These used the engine with fresh random seeds.
- Sampler: for eight container stakes across all modes (150,000 routes each), the per-stop loss rates matched the exact odds; chi-square p-values ranged from 0.049 to 0.967.
- Strategy backtests, 300,000 rounds each (realized RTP, approximate 95% interval):

| Strategy | Realized RTP |
|---|---|
| Easy, $3.33, collect at stop 4 (98.74% under cargo-v1) | 96.87% (96.77–96.98%) |
| Easy, $3.01, A at stop 7, B and C at stop 4 | 96.89% (96.76–97.01%) |
| Medium, $30, collect everything after any loss, otherwise at stop 6 | 96.87% (96.69–97.05%) |
| Expert, collect at stop 1, double the stake after every loss | 96.87% (95.92–97.81%) |
| Random mode, stake and collection, Easy and Medium only | 96.60% (96.16–97.04%) |

Expected and realized returns differ. The same random strategy across all four modes realized 92.96%, although its exact expectation is 96.8000%. About 4.32 percentage points of that expectation come from deep Hard and Expert wins expected fewer than three times in 300,000 rounds, so a sample of that size usually misses them; a normal-approximation interval is not reliable for these returns.

**Browser.** In Chromium:
- A $30.01 bet showed different first-stop risks for A (6.017%) and B/C (6.019%), each on its own card, with no shared figure. A $30.00 bet showed one shared 6.019%.
- The browser verifier confirmed a settled cargo-v2 round.
- A cargo-v1 round placed before a simulated upgrade resumed at 5.000% and then 5.263%, settled at 1.03× and verified.
- The 390-pixel phone layout had no horizontal overflow, and no console warnings or errors appeared.

The hosted site is unchanged until this version is deployed.

## GitHub source package

The latest private hosted interface and the local Node server have been combined into one repository. All 12 backend test groups passed on Node.js 24.19.0. Hosted API checks and collision classification checks passed, and a clean `npm ci --ignore-scripts` followed by the hosted build succeeded.

Collision checks cover single and double cargo losses, simultaneous full loss, cumulative full loss, collected cargo remaining secured, collection without collision, reduced motion and immutable game results. The local server's public-asset allowlist includes the collision module and both PNG obstacle sprites.

The packaged local game loaded in a real browser without warning or error logs. Its collision module and both obstacle PNGs returned HTTP 200 with the correct content types; the PNG lengths matched the source assets.

The pinned development dependency tree reports four moderate npm audit findings in build-tool dependencies. No dependency upgrade was applied during the source migration; these tools are not required to run the local Node game. Review and update build tooling separately before a production release.

The browser observations below were recorded on 6 October 2026 and remain as the original gameplay verification record.

## Automated checks

All **12 backend test groups passed** on Node.js 24.19.0. The original local build targeted Node.js 22 or newer; this repository uses Node.js 24 or newer for its combined local and hosted checks. The local game does not require third-party runtime packages.

Checks cover the 61 payout entries and increasing risk, exact cent splits, rounding, debits/credits, seed commitment consumption, hidden future hazards, invalid bets and actions, secured cargo surviving later losses, final-stop limits, all-lost settlement, independently verified proofs and tampering, deterministic hazard decks, HTTP idempotency, competing revision requests, forbidden origins/hosts, round ownership and persisted-store reload.

## Browser checks

The actual game was opened in the Codex browser against its live local server.

- Difficulty preview confirmed Easy/Medium/Hard/Expert stop counts of 19/17/15/10 and first-stop per-container risks of 5%/15%/25%/50%.
- A $30.01 bet split into A $10.01, B $10.00 and C $10.00, with the full bet deducted once.
- Refresh restored the active voyage and wallet. The restored bet input displays the accepted total rather than a default value.
- Cargo A was collected at stop 1 for $10.31. The remaining cargo continued; C was lost at stop 5 while A's payout stayed secured.
- Cargo B was then collected at stop 5 for $13.10. The settled total was $23.41, net −$6.60, final balance $993.40 from $1,000.00.
- The browser independently verified the seed commitment, all three hazard decks, every stop and every payout for that round.
- Play-balance refill restored $1,000.00 and left completed history intact.
- The mobile layout was checked at a 390-pixel viewport; document width equaled viewport width, with no page-level horizontal overflow. The multiplier strip scrolls within its own panel.
- No browser warning/error logs were found in the tested flow.

These checks validate this play-money build. They do not replace an operator's integration tests, a production security review or external game-math/RNG certification.
