# Cargo randomness, odds and payout specification

This is the implemented algorithm, not a claim of external certification or identity with Stake's RNG.

## Rules versions

Every accepted round stores the rules it was accepted under and keeps them until it settles. Settlement, displayed odds and proof verification all read the round's own versions, never the current defaults. Published versions are never edited; a change is a new version ID.

| Field | Value | Meaning |
|---|---|---|
| `algorithm` | `cargo-v2` (current) | Calibrated per-stop survival odds; exactly 96.8% expected return for every collection strategy |
| `algorithm` | `cargo-v1` (legacy) | Fixed-count hazard deck; nominal 98% before rounding; stake-independent odds |
| `paytable` | `ladder-v1` | The original two-decimal multiplier ladder in `public/math.js` (unchanged) |

Rounds saved before this field existed have `algorithm: 'cargo-v1'` and no `paytable`; they use `ladder-v1`. A cargo-v1 round that is still at sea when the server is upgraded finishes with its original deck and odds, and its proof keeps verifying. Public rounds report both IDs in `proof.algorithm` and `proof.paytable`.

## Commitment

1. A server seed is 32 cryptographically random bytes, encoded as 64 lowercase hexadecimal characters.
2. Its SHA-256 hash is calculated over the **raw 32 bytes**, not the text representation. The next seed's hash is published in `/api/session` before placing a bet.
3. The bet includes `expectedSeedHash`; a stale commitment is rejected. The player may choose a 1–128-character client seed before betting.
4. The round consumes the committed server seed and the session's next nonce. Nonces start at 0 and advance once per accepted round. A fresh seed is prepared for the following round.
5. The consumed seed and every container's route stay hidden until every container has been collected or lost. Its commitment and complete event sequence remain in the settled round proof.

## Stakes and payouts

A total bet splits evenly in cents; remainder cents are assigned to A, then B. Container stakes therefore range from 100 to 100,000 cents. The game debits the whole bet once. Each collection credits its container once. Lost cargo pays zero. Collecting is allowed after stop one; the final port requires collecting the remaining cargo to settle.

For a container stake `w` in cents and the stop-`s` multiplier `m_s` in hundredths, the payout in cents is

`G_s(w) = floor((w × m_s + 50) / 100)` (nearest cent, half up),

which includes the original stake. Easy has 19 stops, Medium 17, Hard 15 and Expert 10. All 61 multipliers are the original `ladder-v1` values, which follow `round(0.98 / survival, 2)` for the legacy deck.

## cargo-v2 odds

Each container is resolved independently using only its own stake `w`. Having survived stop `s − 1` (stop 0 is the harbour), it survives stop `s` with probability

- stop 1: `p_1(w) = 121w / (125 × G_1(w))`
- stop `s ≥ 2`: `p_s(w) = G_{s−1}(w) / G_s(w)`

These are exact ratios of integers (all below 2^53). They are valid probabilities strictly between 0 and 1 for every legal stake: `G_1(w) ≥ 1.03w − 0.5 > 0.968w` when `w ≥ 100`, and consecutive multipliers differ by at least 0.06, so `G_s(w)` rises by at least six cents per stop. `npm run test:rtp` checks this exhaustively.

The survival probability to stop `s` telescopes:

`S_s(w) = p_1 × p_2 × … × p_s = (121w / (125 G_1)) × (G_1 / G_2) × … × (G_{s−1} / G_s) = 0.968w / G_s(w)`

so `S_s(w) × G_s(w) = 0.968w` exactly at every stop.

**This calibration is the only one possible.** If every legal strategy must return exactly 96.8%, then in particular "collect this container at stop `s`" must, which forces `S_s(w) = 0.968w / G_s(w)` for every `s`. The conditional odds `p_s = S_s / S_{s−1}` follow. Keeping the literal multipliers and the cent rounding therefore *requires* stake-dependent odds that do not always rise from one stop to the next.

### Sampling a route

For each container `A`, `B`, `C` with stake `w` from the split, and each stop `s = 1, 2, …, maxStops`:

1. Let `[a, b] = [p_s numerator, p_s denominator]` as defined above, as integers.
2. For `attempt = 0, 1, 2, …`: serialize `['cargo-v2', clientSeed, nonce, containerId, s, attempt]` with JavaScript `JSON.stringify` (exact UTF-8, no added spaces). Calculate HMAC-SHA-256 with the raw server-seed bytes as key. Read the first eight digest bytes as an unsigned big-endian 64-bit integer `v`.
3. Let `limit = 2^64 − (2^64 mod b)`. If `v ≥ limit`, try the next attempt. Otherwise `u = v mod b` is uniform on `[0, b)` with no modulo bias.
4. The container survives stop `s` when `u < a`, which has probability exactly `a / b`. Otherwise it is lost at stop `s`, and no further stops are drawn for it.

The route is computed at bet time and stored as `hazards[containerId]`: `[]` if the container survives every stop, otherwise `[s]` for the stop where it is lost. Sailing to stop `s` loses every on-board container whose route lists `s`. Collected cargo is no longer resolved.

The container ID, stop number and attempt separate every HMAC input, so no draw is reused. Routes also vary with the client seed, nonce and server seed. The rejection probability per draw is below `b / 2^64 < 10^−9`.

## Return: proofs

**Assumptions.**
- (A1) HMAC-SHA-256 outputs keyed by the secret server seed behave as independent uniform values for distinct inputs (the standard pseudorandom-function model). This makes each container's trials independent of each other and of the other containers.
- (A2) The server seed stays secret until settlement, so every decision is made without knowledge of future draws. The commitment scheme above enforces this.
- (A3) The strategy fully resolves each round. Cargo left on board in an abandoned round is never credited, so abandoning a round can only lower the return.

**Theorem 1 (fixed stops).** Collecting a container at a fixed stop `s` has expected payout `S_s(w) × G_s(w) = 0.968w`.

**Theorem 2 (every adaptive collection strategy).** Let `F_s` be everything the player knows after the outcome of stop `s`: every container's history up to `s`, previous rounds, the wallet, and any private randomness. For one container, define `M_s = G_s(w)` if it is still on board after stop `s`, and `M_s = 0` once it is lost. By (A1), its survival of stop `s + 1` is independent of `F_s` with probability `p_{s+1} = G_s / G_{s+1}`, so

`E[M_{s+1} | F_s] = p_{s+1} × G_{s+1} = G_s = M_s` while on board, and `0 = M_s` after a loss.

So `M` is a martingale with respect to `F`. Any strategy collects the container at a stopping time `τ ≤ maxStops` of `F`: collection is allowed from stop 1, and the final port forces it. The payout is exactly `M_τ`, because a container lost earlier has `M_τ = 0`. Bounded optional stopping gives

`E[payout] = E[M_τ] = E[M_1] = p_1 × G_1 = 0.968w`.

This holds for every rule: collecting early or late, collecting one container because another sank, or reacting to the wallet or to past rounds. Summing over A, B and C, every legal strategy returns exactly `0.968 × (total bet)` in expectation, for every legal total bet.

**Theorem 3 (across rounds).** A fresh committed seed makes round `k`'s outcomes independent of everything before it. So for any stake `W_k` chosen from past information (changing stakes, doubling after losses, stopping after a win), `E[R_k | past] = 0.968 W_k`. `D_n = Σ_{k≤n} (R_k − 0.968 W_k)` is then a martingale with bounded increments: stakes are capped at $3,000 and payouts are bounded. For any stopping rule `T` with `E[T] < ∞`, `E[Σ R_k] = 0.968 E[Σ W_k]`, so the expected net result is `−0.032 × E[total wagered]`. No combination of stake changes, loss chasing or adaptive collection has positive expectation.

**Expected and realized returns.** These are statements about expectations, as the ratio of expected return to expected amount wagered. Realized results differ, sometimes substantially. Deep stops pay up to 181,060.88× with small probabilities, so short and medium samples usually come in below 96.8%, and an occasional rare win makes them far above it. Simulations illustrate the behavior but do not prove it; the exact checks below and the proofs above are the basis of the 96.8% claim. See [TESTED.md](TESTED.md) for simulation results.

## Gameplay changes from cargo-v1

- **Payouts are unchanged.** Every multiplier, the cent rounding and the stake split are the same.
- **The first stop is riskier.** It absorbs most of the change from about 98% to 96.8%. Easy stop-1 loss rises from 5% to about 6.0%, Medium from 15% to about 15.8%, Hard from 25% to about 26.1%, and Expert from 50% to about 50.6%.
- **Later stops are close to the old odds** but follow the rounding of the published multipliers. As a result, **the loss chance can fall from one stop to the next**. For example, Easy at $10 per container has 6.019%, 5.505%, 5.217%, then 6.504%.
- **Odds depend on the stake.** Containers whose stakes differ (for example $10.01/$10.00/$10.00 from a $30.01 bet) can have slightly different odds at the same stop. The interface shows each container's own next-stop risk and shows a single figure only when the odds are identical.
- **The final port is slightly rarer.** It is reached by 1 in about 20.2 Easy containers (was 1 in 20), 1 in 1,154 Medium (was 1,140), 1 in 15,696 Hard (was 15,504) and 1 in 187,046 Expert (was 184,756).
- **Containers are still independent.** One container's loss says nothing about another's route.

Loss chance per stop, cargo-v1 fixed deck compared with the cargo-v2 range over every container stake (Easy shown in full; `npm run test:rtp -- --table` prints every mode):

| Easy stop | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11–19 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cargo-v1 | 5.000% | 5.263% | 5.556% | 5.882% | 6.250% | 6.667% | 7.143% | 7.692% | 8.333% | 9.091% | 10.0–50.0% |
| cargo-v2 | 5.64–6.40% | 5.07–6.03% | 4.73–5.83% | 5.93–7.09% | 5.52–6.72% | 5.92–6.90% | 6.91–7.84% | 6.90–7.66% | 8.04–8.79% | 8.89–9.55% | within 0.5 points of cargo-v1 |

| First stop | Easy | Medium | Hard | Expert |
|---|---|---|---|---|
| cargo-v1 | 5.000% | 15.000% | 25.000% | 50.000% |
| cargo-v2 | 5.640–6.400% | 15.505–16.157% | 25.855–26.348% | 50.505–50.720% |

## Verification

`public/fairness.js` uses browser Web Crypto to independently reproduce the commitment and each container's route. For cargo-v2 it recomputes the odds from the payout formula; it does not call the server's helper. For cargo-v1 it reproduces the legacy shuffle. It then replays all sail and collection events with the round's own payout table, checks terminal container states and reconciles returned/net amounts. Unknown or altered rules versions fail. **Fairness → Verify round** runs this check, and `node tools/verify-round.mjs` checks an exported proof.

`npm run test:rtp` independently and exactly checks, using integer arithmetic:
- the literal ladder;
- the engine's odds against the formula, for every container stake from 100 to 100,000 cents in every mode (399,604 stakes, 6,093,961 stop checks);
- that every fixed stop returns exactly 96.8%;
- that the best and the worst stopping rules, found by exact backward induction, both return exactly 96.8%, so every stopping rule does;
- every legal total wager from $3.00 to $3,000.00 in every mode.

Backend tests cover the sampler's rejection step, route determinism, per-container odds, pinned rules, a cargo-v1 round finishing after the upgrade, and historical cargo-v1 proofs exported by the original engine (`test/fixtures/cargo-v1-proofs.json`).

## Legacy cargo-v1 hazard decks

Rounds with `algorithm: 'cargo-v1'` use this procedure. For each of `A`, `B`, `C`, initialize `[1, 2, …, 20]` and a separate counter at 0. Shuffle with Fisher–Yates, descending from index 19 to index 1.

For a required uniform integer with bound `b`:

1. Serialize the array `['cargo-v1', clientSeed, nonce, containerId, counter]` with JavaScript `JSON.stringify`, including its exact UTF-8 encoding and no added spaces.
2. Calculate HMAC-SHA-256 with the raw server seed bytes as key and that serialized message. Increment the counter.
3. Interpret the first four digest bytes as an unsigned big-endian 32-bit integer `v`.
4. Let `limit = floor(2^32 / b) × b`. If `v >= limit`, draw again. Otherwise use `v % b`. This rejection removes modulo bias.
5. At shuffle index `i`, swap element `i` with the drawn index in `[0, i]`.

Select the first `h` shuffled positions, then sort ascending. Hazard counts are 1/3/5/10 for Easy/Medium/Hard/Expert. A container still on board is lost when a sailed stop is in its own hazard deck. Before stop `s`, a surviving container's loss probability is `h / (21 − s)`, and survival through `s` stops is `choose(20 − s, h) / choose(20, h)`. The ladder follows `round(0.98 / survival, 2)`, so cargo-v1's return is 98% only before multiplier and cent rounding; it varies by stop and stake.
