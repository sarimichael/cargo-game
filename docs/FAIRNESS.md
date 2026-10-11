# Cargo v1 randomness and payout specification

This is the implemented algorithm, not a claim of external certification or identity with Stake's RNG.

## Commitment

1. A server seed is 32 cryptographically random bytes, encoded as 64 lowercase hexadecimal characters.
2. Its SHA-256 hash is calculated over the **raw 32 bytes**, not the text representation. The next seed's hash is published in `/api/session` before placing a bet.
3. The bet includes `expectedSeedHash`; a stale commitment is rejected. The player may choose a 1–128-character client seed before betting.
4. The round consumes the committed server seed and the session's next nonce. Nonces start at 0 and advance once per accepted round. A fresh seed is prepared for the following round.
5. The consumed seed stays hidden until every container has been collected or lost. Its commitment and complete event sequence remain in the settled round proof.

## Independent hazard decks

For each of `A`, `B`, `C`, initialize `[1, 2, …, 20]` and a separate counter at 0. Shuffle with Fisher–Yates, descending from index 19 to index 1.

For a required uniform integer with bound `b`:

1. Serialize the array `['cargo-v1', clientSeed, nonce, containerId, counter]` with JavaScript `JSON.stringify`, including its exact UTF-8 encoding and no added spaces.
2. Calculate HMAC-SHA-256 with the raw server seed bytes as key and that serialized message. Increment the counter.
3. Interpret the first four digest bytes as an unsigned big-endian 32-bit integer `v`.
4. Let `limit = floor(2^32 / b) × b`. If `v >= limit`, draw again. Otherwise use `v % b`. This rejection removes modulo bias.
5. At shuffle index `i`, swap element `i` with the drawn index in `[0, i]`.

Select the first `h` shuffled positions, then sort ascending. Hazard counts are 1/3/5/10 for Easy/Medium/Hard/Expert. A container still on board is lost when a sailed stop is in its own hazard deck. Collected cargo is no longer resolved.

The container ID separates the three HMAC streams. Streams also vary with the client seed, nonce and server seed.

## Stop counts, odds and payouts

Each difficulty permits `20 − h` stops. Before attempting stop `s`, a container that survived prior stops has loss probability:

`h / (21 − s)`

Cumulative survival through `s` stops is:

`choose(20 − s, h) / choose(20, h)`

New bets use payout table `rtp-96.8`, which follows `round(0.968 / survival, 2)` with exact half-up rounding. Use the integer hundredths in `public/math.js` as the authoritative table.

The 96.8% factor is nominal **before multiplier rounding and cent rounding**. The rounded table changes the return at particular stops; do not label every checkpoint as exactly 96.8%. With whole-dollar container stakes, collecting all cargo at one fixed stop returns between 96.60% and 97.20% depending on the stop. Choosing the best stop and a stake whose cents round favorably raises the maximum to 97.570093% (Easy, $1.07 per container, collected at stop 2); no stake or strategy reaches 100%.

### Payout table versions

Each round stores the payout table that was current when its bet was accepted, and settlement, the public multiplier and verification all use that table. The ID is reported as `proof.paytable`. Published tables are never edited; a new return target is a new table ID.

| Table | Formula | Used by |
|---|---|---|
| `rtp-96.8` | `round(0.968 / survival, 2)` | Every round accepted from this version onward |
| `rtp-98` | `round(0.98 / survival, 2)` (matches the two-decimal Chicken ladder) | Rounds saved before table versioning, including any still at sea during the upgrade; these continue and verify at the original multipliers |

A round or exported proof without a table ID is an `rtp-98` round. For a container stake in cents `w` and a multiplier in hundredths `m`, its payout in cents is `floor((w × m + 50) / 100)` (nearest cent, half up). A payout includes its original stake.

A total bet splits evenly in cents; remainder cents are assigned to A, then B. The game debits the whole bet once. Each collection credits its container once. Lost cargo pays zero. Collecting is allowed after stop one; the final port requires collecting the remaining cargo to settle.

## Verification

`public/fairness.js` uses browser Web Crypto to independently reproduce the commitment and each shuffle. It then replays all sail and collection events, checks terminal container states and reconciles returned/net amounts. **Fairness → Verify round** runs this check. Exported JSON proofs contain the necessary inputs and event sequence.

Backend tests additionally check all 61 multipliers against the survival formula, cent conservation, rejected invalid actions, exact ledger reconciliation, retry idempotency, competing revisions, seed secrecy and tampered proofs.
