# Build verification — 7 October 2026

## 96.8% payout table — 11 October 2026

New bets use payout table `rtp-96.8` (`round(0.968 / survival, 2)`); each round stores its table, and rounds saved without one keep the original `rtp-98` table. All 13 backend test groups, the hosted API check and the collision checks passed on Node.js 22.22.0 (the project targets Node.js 24 or newer).

- Exact optimal-stopping analysis over every container stake from $1.00 to $1,000.00: fixed-stop RTP for whole-dollar stakes is 96.60–97.20%; the best achievable RTP is 97.570093% (Easy, $1.07 per container, stop 2). No stake or strategy reaches 100%.
- 300,000-round simulations through the engine with fresh random seeds matched theory: Hard at stop 5 returned 96.87% (theory 96.85%); the best strategy returned 97.59% (theory 97.57%).
- In Chromium, a new round showed and paid 1.02× at Easy stop 1. A round placed before a simulated upgrade showed 1.03× after the restart and settled at $30.90 on a $30.00 bet. The 390-pixel phone layout had no horizontal overflow, and no console warnings or errors appeared.

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
