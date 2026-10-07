# CARGO — SAYCOVE PRE-INTEGRATION AUDIT

Audit date: 7 October 2026. Scope: private Cargo source and isolated local execution. Audited commit: [25d5181fbd82abbd22aaea4b32f546e94f9c3602](https://github.com/sarimichael/cargo-game/commit/25d5181fbd82abbd22aaea4b32f546e94f9c3602).

## 1. Executive summary

Cargo's implemented mathematics is coherent, its three-container accounting conserves the wager, and the tested cash-out paths resisted duplicate credits, competing actions, forged financial fields, and disconnect/retry attacks. No legitimate strategy reaching 100% RTP was found. No active-round future-result leak was found in the inspected source or tested API/browser responses.

The highest achievable theoretical gross RTP under the implemented rules, across every permitted integer-cent wager and all non-anticipating cash-out strategies, is **98.738738%**, using **$3.33 on Easy and collecting surviving cargo at stop 4**. The corresponding house edge is **1.261262%**. This conclusion assumes the implemented cryptographic shuffle behaves as a uniform pseudorandom shuffle; it is not a claim that finite statistical testing proves cryptographic security.

The prototype is not yet suitable for a real-money integration. It has anonymous play wallets and a free refill endpoint, no external wallet settlement/rollback state machine, no authenticated operator launch, no reliable recovery after losing the anonymous session credential, unbounded session rows, and no approved exposure control. An unfinished round also uses the currently installed payout table rather than a pinned math version. These are material integration blockers independent of whether Saycove has finalized its protocol.

**Completed in this audit:**

- Read README.md and AGENTS.md; retrieved the latest main branch and pinned the audit to the commit above. All 38 non-PNG tracked files matched their Git blob hashes. The two omitted files are iceberg/debris artwork; no executable source was omitted.
- Re-ran all 12 existing backend test groups, the hosted Worker/SQLite check, and collision checks successfully. The first backend-test invocation was blocked by the sandbox's child-process restriction; the authorized rerun passed. Historical results were not treated as current results.
- Enumerated all **201,420 possible hazard subsets** across the four modes, verifying the analytical survival counts exactly.
- Checked all **299,701 permitted total wagers**; checked **6,093,961 stake/multiplier payout pairs against independent BigInt arithmetic**, with zero mismatches; exercised **305 backend settlement fixtures** across all 61 multipliers.
- Solved optimal stopping, swept the entire wager range, and independently checked the joint three-container Bellman model on 36 representative mode/wager cases.
- Simulated **4,000,000 rounds / 12,000,000 cargo routes**, one million rounds per difficulty, using the unmodified production hazardDeck and newSeed functions.
- Completed **18 additional adversarial test groups**, including 80 cash-out/elimination races across both adapters, plus targeted versioning, TCP-disconnect, verifier and idempotency tests. Some groups intentionally reproduce defects; a successful reproduction is not a safety PASS for that feature.
- Exercised a real local browser with a $3.01 wager, separate collection, a second tab, refresh, final settlement and the browser's independent verifier. Captured and inspected its API response bodies.

**Not verified:** actual deployed Worker binary/source equivalence; Cloudflare production failover, database backups or power-loss behavior; deployment secrets/IAM/entropy configuration; independent laboratory certification; penetration testing of hosting infrastructure; and any Saycove-specific wallet or launch contract. The private prototype opened at an authentication gate, so authenticated live traffic and live financial behavior were **NOT VERIFIED**. Its audience was not changed. The local audit copy was tested instead. No production game source or live deployment was modified.

Saycove's [official website](https://saycove.com/) was inspected. The user confirmed that there is no finalized public integration specification. Throughout this report, protocol-specific compatibility is **NOT VERIFIED — REQUIRES SAYCOVE INTEGRATION SPEC**. The architectural requirements below are engineering prerequisites for a real-money B2B remote game server (RGS), not invented Saycove requirements.

### Issue register

| ID | Severity | Finding |
| --- | --- | --- |
| F01 | HIGH | Anonymous play-money creation/refill has no real-money launch boundary |
| F02 | HIGH | External debit, credit, rollback and reconciliation lifecycle is absent |
| F03 | HIGH | Unbounded session JSON can prevent collection when the hosted row limit is reached |
| F04 | HIGH | Maximum round exposure reaches $543,182,640 without a win cap or exposure control |
| F05 | HIGH | Lost-session and abandoned/final-stop recovery is incomplete |
| F06 | MEDIUM | Nominal 98% differs from the wager- and strategy-dependent actual RTP |
| F07 | HIGH | Local file store loses updates with multiple instances and lacks crash-durability guarantees |
| F08 | MEDIUM | Independent proof verifier accepts altered unvalidated metadata |
| F09 | MEDIUM | No application-level session/rate/retention controls |
| F10 | LOW | Idempotency keys have reserved-name and JSON-property-order pitfalls |
| F11 | HIGH | Math/settlement version is not pinned to the round at wager acceptance |


No CRITICAL player-edge or future-leakage exploit was demonstrated. This is bounded evidence, not an assertion that all attacks have been ruled out. F01 would become a critical money-creation vulnerability if its play balances or refill credits were treated as withdrawable real money.

## 2. Exact game rules discovered from code

The authoritative rules are in [public/math.js:2](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/public/math.js#L2) and [server/game.js:31](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/game.js#L31); local HTTP and hosted Worker adapters call the same engine.

1. One integer-cent USD total wager W is debited once. Allowed W is 300–300,000 cents ($3–$3,000), inclusive and limited by the available balance. A new anonymous wallet begins at 100,000 cents ($1,000), so a fresh wallet cannot immediately wager $3,000.
2. Let b=floor(W/3) and r=W mod 3. A receives b+1 cents if r≥1; B receives b+1 if r=2; C receives b. Thus $3.01 becomes $1.01/$1.00/$1.00, and $3.02 becomes $1.01/$1.01/$1.00. No cents disappear or get debited twice.
3. Each cargo receives its own shuffled 20-position hazard route. The selected difficulty determines h hazard positions in that route. Difficulty and wager cannot be changed after acceptance through any implemented API.
4. A new round starts at stop 0. Collecting at stop 0 is prohibited. An advance attempts exactly one shared next stop for every still-onboard cargo. Each cargo is lost if that stop occurs in its own hazard set.
5. After surviving stop s≥1, any still-onboard cargo may be collected individually, or all remaining cargo may be collected together. Collection credits the current stop's total-return multiplier, including the cargo's original stake. Lost cargo returns zero.
6. Collected cargo is never exposed to later hazards. A single round can therefore contain both secured payouts and later losses. Container terminal states are mutually exclusive.
7. The voyage settles when all three cargoes are either collected or lost. All-lost settles automatically. Reaching the final stop with survivors does **not** automatically credit them; a collect request is still required. No time-based elimination is implemented: advance requests cause elimination, not wall-clock time or the animation.
8. Maximum total payout is the sum of the independently rounded container credits. There is no maximum-win cap. At a fixed stop the multiplier applies to each container's allocated stake, not to the full wager three times.

| Difficulty | Hazards h / 20 | Permitted stops | First multiplier | Final multiplier | Final survival per cargo |
| --- | --- | --- | --- | --- | --- |
| Easy | 1 | 19 | 1.03× | 19.60× | 1 / 20 |
| Medium | 3 | 17 | 1.15× | 1,117.20× | 1 / 1140 |
| Hard | 5 | 15 | 1.31× | 15,193.92× | 1 / 15504 |
| Expert | 10 | 10 | 1.96× | 181,060.88× | 1 / 184756 |


**Independence:** A/B/C use separate HMAC message domains through the container ID. They do not share one hazard deck. Within a cargo, stops are dependent because its h hazards are sampled without replacement: surviving earlier stops increases the conditional risk of the next stop. Different cargo routes and fresh-seed rounds are computationally independent under the HMAC assumption. Adaptive strategies can make the eventual payout amounts correlated through the player's decisions; that does not imply an RNG correlation.

**Intended versus implemented:** the stop counts, all 61 multipliers, three-container stake split, secured cargo, and server-authoritative collision mapping match the supplied handoff. A cumulative all-lost state triggers the iceberg; partial losses use debris; collection does not trigger collision. These classifications passed the existing collision checks. The nominal 98% target is not a constant actual RTP, but docs/FAIRNESS.md already discloses the rounding caveat. Manual final-stop collection and anonymous play-wallet limitations are also documented; they remain integration gaps rather than undocumented gameplay changes. No additional gameplay mismatch was found within the audited source.

## 3. Mathematical model

For a difficulty with h hazards, let D=C(20,h), and let s be a stop in 1…20−h. Set S₀=1.

- Conditional loss on attempting stop s, given this cargo survived stops 1…s−1: **pₛ=h/(21−s)**.
- Conditional survival: **qₛ=(21−s−h)/(21−s)=1−pₛ**.
- Cumulative survival: **Sₛ=C(20−s,h)/C(20,h)=∏ⱼ₌₁ˢqⱼ**.
- Cumulative loss: **1−Sₛ**. This is distinct from the displayed *next-stop conditional* risk.
- Multiplier integer Mₛ is the table value in hundredths. Displayed multiplier mₛ=Mₛ/100. The table equals **round(98/Sₛ)** in integer hundredths.
- Exact gross payout for a surviving stake of w cents: **g(w,s)=floor((wMₛ+50)/100)** cents. This is nearest-cent, half-up rounding, once per cargo.
- For a fixed target stop s: **E[gross credit]=Sₛg(w,s)**, **RTP(w,s)=Sₛg(w,s)/w**, **net EV=w(RTP−1)**, and **house edge=1−RTP**.
- For total wager W split into wᵢ and fixed collection stops sᵢ: **RTP=Σᵢ Sₛᵢg(wᵢ,sᵢ)/W**. The maximum possible gross credit for those targets is Σᵢg(wᵢ,sᵢ). A cargo lost before its target contributes zero.

For equal stakes with no cent-rounding effect and all cargo targeting the same stop, K survivors is Binomial(3,Sₛ). The total return divided by W is X=mₛK/3. Therefore:

**P(K=k)=C(3,k)Sₛᵏ(1−Sₛ)³⁻ᵏ; E[X]=Sₛmₛ; Var(X)=mₛ²Sₛ(1−Sₛ)/3.**

For unequal stakes, the distribution is the eight independent survivor subsets and Var(gross credit)=Σᵢg(wᵢ,s)²Sₛ(1−Sₛ). Hit rate means at least one positive payout, **1−(1−Sₛ)³**. Zero-return rate is (1−Sₛ)³. A positive payout can still be a net loss; net-loss rate is separately defined as P(gross credit<W).

The model was derived before comparison with simulation. Enumeration of every hazard subset reproduced the cumulative survival numerator at every stop. There are 20 Easy subsets, 1,140 Medium, 15,504 Hard and 184,756 Expert. The underlying cryptographic uniformity assumption is discussed in section 7.

## 4. RTP and house-edge tables

All percentages below are computed from the exact combinatorial fractions. Printed decimals are rounded for presentation. The odds table gives both conditional and cumulative quantities. The return table's baseline is any equal container stake in whole dollars (for example, $3 or $30 total), so cent rounding adds no change. EV is gross dollars returned per $1 wagered; net EV is EV−$1. “Cent RTP range” is the exhaustive minimum–maximum over every allowed total wager when all surviving containers are collected at that row's stop. Its house-edge range is 100% minus those endpoints in reverse order.

“Max gross” is the whole-round maximum at the $3,000 total wager if all three cargoes survive and are collected at that stop. At this wager, the single-cargo maximum is exactly one third of that number. For another wager use the exact payout formula above.

### Easy — odds

| Stop | Conditional survival | Conditional loss | Cumulative survival | Cumulative loss |
| --- | --- | --- | --- | --- |
| 1 | 95.000000% | 5.000000% | 95.000000% | 5.000000% |
| 2 | 94.736842% | 5.263158% | 90.000000% | 10.000000% |
| 3 | 94.444444% | 5.555556% | 85.000000% | 15.000000% |
| 4 | 94.117647% | 5.882353% | 80.000000% | 20.000000% |
| 5 | 93.750000% | 6.250000% | 75.000000% | 25.000000% |
| 6 | 93.333333% | 6.666667% | 70.000000% | 30.000000% |
| 7 | 92.857143% | 7.142857% | 65.000000% | 35.000000% |
| 8 | 92.307692% | 7.692308% | 60.000000% | 40.000000% |
| 9 | 91.666667% | 8.333333% | 55.000000% | 45.000000% |
| 10 | 90.909091% | 9.090909% | 50.000000% | 50.000000% |
| 11 | 90.000000% | 10.000000% | 45.000000% | 55.000000% |
| 12 | 88.888889% | 11.111111% | 40.000000% | 60.000000% |
| 13 | 87.500000% | 12.500000% | 35.000000% | 65.000000% |
| 14 | 85.714286% | 14.285714% | 30.000000% | 70.000000% |
| 15 | 83.333333% | 16.666667% | 25.000000% | 75.000000% |
| 16 | 80.000000% | 20.000000% | 20.000000% | 80.000000% |
| 17 | 75.000000% | 25.000000% | 15.000000% | 85.000000% |
| 18 | 66.666667% | 33.333333% | 10.000000% | 90.000000% |
| 19 | 50.000000% | 50.000000% | 5.000000% | 95.000000% |

### Easy — payouts and returns

| Stop | Multiplier | Gross EV / $1 | RTP | House edge | Cent RTP range | Max gross at $3,000 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.03× | 0.97850000 | 97.850000% | 2.150000% | 97.456897%–98.247863% | $3,090.00 |
| 2 | 1.09× | 0.98100000 | 98.100000% | 1.900000% | 97.714286%–98.490566% | $3,270.00 |
| 3 | 1.15× | 0.97750000 | 97.750000% | 2.250000% | 97.378641%–98.136364% | $3,450.00 |
| 4 | 1.23× | 0.98400000 | 98.400000% | 1.600000% | 98.039216%–98.738739% | $3,690.00 |
| 5 | 1.31× | 0.98250000 | 98.250000% | 1.750000% | 97.916667%–98.571429% | $3,930.00 |
| 6 | 1.40× | 0.98000000 | 98.000000% | 2.000000% | 97.722772%–98.269231% | $4,200.00 |
| 7 | 1.51× | 0.98150000 | 98.150000% | 1.850000% | 97.939189%–98.465347% | $4,530.00 |
| 8 | 1.63× | 0.97800000 | 97.800000% | 2.200000% | 97.560976%–98.076923% | $4,890.00 |
| 9 | 1.78× | 0.97900000 | 97.900000% | 2.100000% | 97.663551%–98.137255% | $5,340.00 |
| 10 | 1.96× | 0.98000000 | 98.000000% | 2.000000% | 97.787611%–98.214286% | $5,880.00 |
| 11 | 2.18× | 0.98100000 | 98.100000% | 1.900000% | 97.916667%–98.300971% | $6,540.00 |
| 12 | 2.45× | 0.98000000 | 98.000000% | 2.000000% | 97.821782%–98.181818% | $7,350.00 |
| 13 | 2.80× | 0.98000000 | 98.000000% | 2.000000% | 97.864078%–98.137255% | $8,400.00 |
| 14 | 3.27× | 0.98100000 | 98.100000% | 1.900000% | 97.981651%–98.235294% | $9,810.00 |
| 15 | 3.92× | 0.98000000 | 98.000000% | 2.000000% | 97.897196%–98.113208% | $11,760.00 |
| 16 | 4.90× | 0.98000000 | 98.000000% | 2.000000% | 97.924528%–98.095238% | $14,700.00 |
| 17 | 6.53× | 0.97950000 | 97.950000% | 2.050000% | 97.887931%–98.019802% | $19,590.00 |
| 18 | 9.80× | 0.98000000 | 98.000000% | 2.000000% | 97.961165%–98.039216% | $29,400.00 |
| 19 | 19.60× | 0.98000000 | 98.000000% | 2.000000% | 97.980769%–98.019802% | $58,800.00 |

### Medium — odds

| Stop | Conditional survival | Conditional loss | Cumulative survival | Cumulative loss |
| --- | --- | --- | --- | --- |
| 1 | 85.000000% | 15.000000% | 85.000000% | 15.000000% |
| 2 | 84.210526% | 15.789474% | 71.578947% | 28.421053% |
| 3 | 83.333333% | 16.666667% | 59.649123% | 40.350877% |
| 4 | 82.352941% | 17.647059% | 49.122807% | 50.877193% |
| 5 | 81.250000% | 18.750000% | 39.912281% | 60.087719% |
| 6 | 80.000000% | 20.000000% | 31.929825% | 68.070175% |
| 7 | 78.571429% | 21.428571% | 25.087719% | 74.912281% |
| 8 | 76.923077% | 23.076923% | 19.298246% | 80.701754% |
| 9 | 75.000000% | 25.000000% | 14.473684% | 85.526316% |
| 10 | 72.727273% | 27.272727% | 10.526316% | 89.473684% |
| 11 | 70.000000% | 30.000000% | 7.368421% | 92.631579% |
| 12 | 66.666667% | 33.333333% | 4.912281% | 95.087719% |
| 13 | 62.500000% | 37.500000% | 3.070175% | 96.929825% |
| 14 | 57.142857% | 42.857143% | 1.754386% | 98.245614% |
| 15 | 50.000000% | 50.000000% | 0.877193% | 99.122807% |
| 16 | 40.000000% | 60.000000% | 0.350877% | 99.649123% |
| 17 | 25.000000% | 75.000000% | 0.087719% | 99.912281% |

### Medium — payouts and returns

| Stop | Multiplier | Gross EV / $1 | RTP | House edge | Cent RTP range | Max gross at $3,000 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.15× | 0.97750000 | 97.750000% | 2.250000% | 97.378641%–98.136364% | $3,450.00 |
| 2 | 1.37× | 0.98063158 | 98.063158% | 1.936842% | 97.732794%–98.348310% | $4,110.00 |
| 3 | 1.64× | 0.97824561 | 97.824561% | 2.175439% | 97.556977%–98.076923% | $4,920.00 |
| 4 | 2.00× | 0.98245614 | 98.245614% | 1.754386% | 98.245614%–98.245614% | $6,000.00 |
| 5 | 2.46× | 0.98184211 | 98.184211% | 1.815789% | 98.002432%–98.355263% | $7,380.00 |
| 6 | 3.07× | 0.98024561 | 98.024561% | 1.975439% | 97.878341%–98.154646% | $9,210.00 |
| 7 | 3.91× | 0.98092982 | 98.092982% | 1.907018% | 97.984111%–98.200501% | $11,730.00 |
| 8 | 5.08× | 0.98035088 | 98.035088% | 1.964912% | 97.947699%–98.114445% | $15,240.00 |
| 9 | 6.77× | 0.97986842 | 97.986842% | 2.013158% | 97.925557%–98.052116% | $20,310.00 |
| 10 | 9.31× | 0.98000000 | 98.000000% | 2.000000% | 97.953216%–98.045113% | $27,930.00 |
| 11 | 13.30× | 0.98000000 | 98.000000% | 2.000000% | 97.972710%–98.035088% | $39,900.00 |
| 12 | 19.95× | 0.98000000 | 98.000000% | 2.000000% | 97.980085%–98.022329% | $59,850.00 |
| 13 | 31.92× | 0.98000000 | 98.000000% | 2.000000% | 97.987375%–98.013903% | $95,760.00 |
| 14 | 55.86× | 0.98000000 | 98.000000% | 2.000000% | 97.992578%–98.007154% | $167,580.00 |
| 15 | 111.72× | 0.98000000 | 98.000000% | 2.000000% | 97.996137%–98.003630% | $335,160.00 |
| 16 | 279.30× | 0.98000000 | 98.000000% | 2.000000% | 97.998700%–98.001671% | $837,900.00 |
| 17 | 1,117.20× | 0.98000000 | 98.000000% | 2.000000% | 97.999656%–98.000341% | $3,351,600.00 |

### Hard — odds

| Stop | Conditional survival | Conditional loss | Cumulative survival | Cumulative loss |
| --- | --- | --- | --- | --- |
| 1 | 75.000000% | 25.000000% | 75.000000% | 25.000000% |
| 2 | 73.684211% | 26.315789% | 55.263158% | 44.736842% |
| 3 | 72.222222% | 27.777778% | 39.912281% | 60.087719% |
| 4 | 70.588235% | 29.411765% | 28.173375% | 71.826625% |
| 5 | 68.750000% | 31.250000% | 19.369195% | 80.630805% |
| 6 | 66.666667% | 33.333333% | 12.912797% | 87.087203% |
| 7 | 64.285714% | 35.714286% | 8.301084% | 91.698916% |
| 8 | 61.538462% | 38.461538% | 5.108359% | 94.891641% |
| 9 | 58.333333% | 41.666667% | 2.979876% | 97.020124% |
| 10 | 54.545455% | 45.454545% | 1.625387% | 98.374613% |
| 11 | 50.000000% | 50.000000% | 0.812693% | 99.187307% |
| 12 | 44.444444% | 55.555556% | 0.361197% | 99.638803% |
| 13 | 37.500000% | 62.500000% | 0.135449% | 99.864551% |
| 14 | 28.571429% | 71.428571% | 0.038700% | 99.961300% |
| 15 | 16.666667% | 83.333333% | 0.006450% | 99.993550% |

### Hard — payouts and returns

| Stop | Multiplier | Gross EV / $1 | RTP | House edge | Cent RTP range | Max gross at $3,000 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.31× | 0.98250000 | 98.250000% | 1.750000% | 97.916667%–98.571429% | $3,930.00 |
| 2 | 1.77× | 0.97815789 | 97.815789% | 2.184211% | 97.581792%–98.065015% | $5,310.00 |
| 3 | 2.46× | 0.98184211 | 98.184211% | 1.815789% | 98.002432%–98.355263% | $7,380.00 |
| 4 | 3.48× | 0.98043344 | 98.043344% | 1.956656% | 97.909450%–98.152402% | $10,440.00 |
| 5 | 5.06× | 0.98008127 | 98.008127% | 1.991873% | 97.922042%–98.089868% | $15,180.00 |
| 6 | 7.59× | 0.98008127 | 98.008127% | 1.991873% | 97.951124%–98.064164% | $22,770.00 |
| 7 | 11.81× | 0.98035797 | 98.035797% | 1.964203% | 97.998904%–98.070324% | $35,430.00 |
| 8 | 19.18× | 0.97978328 | 97.978328% | 2.021672% | 97.957516%–98.001142% | $57,540.00 |
| 9 | 32.89× | 0.98008127 | 98.008127% | 1.991873% | 97.995356%–98.020734% | $98,670.00 |
| 10 | 60.29× | 0.97994582 | 97.994582% | 2.005418% | 97.987616%–98.001275% | $180,870.00 |
| 11 | 120.59× | 0.98002709 | 98.002709% | 1.997291% | 97.999121%–98.006236% | $361,770.00 |
| 12 | 271.32× | 0.98000000 | 98.000000% | 2.000000% | 97.998479%–98.001562% | $813,960.00 |
| 13 | 723.52× | 0.98000000 | 98.000000% | 2.000000% | 97.999476%–98.000644% | $2,170,560.00 |
| 14 | 2,532.32× | 0.98000000 | 98.000000% | 2.000000% | 97.999837%–98.000167% | $7,596,960.00 |
| 15 | 15,193.92× | 0.98000000 | 98.000000% | 2.000000% | 97.999973%–98.000029% | $45,581,760.00 |

### Expert — odds

| Stop | Conditional survival | Conditional loss | Cumulative survival | Cumulative loss |
| --- | --- | --- | --- | --- |
| 1 | 50.000000% | 50.000000% | 50.000000% | 50.000000% |
| 2 | 47.368421% | 52.631579% | 23.684211% | 76.315789% |
| 3 | 44.444444% | 55.555556% | 10.526316% | 89.473684% |
| 4 | 41.176471% | 58.823529% | 4.334365% | 95.665635% |
| 5 | 37.500000% | 62.500000% | 1.625387% | 98.374613% |
| 6 | 33.333333% | 66.666667% | 0.541796% | 99.458204% |
| 7 | 28.571429% | 71.428571% | 0.154799% | 99.845201% |
| 8 | 23.076923% | 76.923077% | 0.035723% | 99.964277% |
| 9 | 16.666667% | 83.333333% | 0.005954% | 99.994046% |
| 10 | 9.090909% | 90.909091% | 0.000541% | 99.999459% |

### Expert — payouts and returns

| Stop | Multiplier | Gross EV / $1 | RTP | House edge | Cent RTP range | Max gross at $3,000 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.96× | 0.98000000 | 98.000000% | 2.000000% | 97.787611%–98.214286% | $5,880.00 |
| 2 | 4.14× | 0.98052632 | 98.052632% | 1.947368% | 97.956055%–98.152834% | $12,420.00 |
| 3 | 9.31× | 0.98000000 | 98.000000% | 2.000000% | 97.953216%–98.045113% | $27,930.00 |
| 4 | 22.61× | 0.98000000 | 98.000000% | 2.000000% | 97.980515%–98.017490% | $67,830.00 |
| 5 | 60.29× | 0.97994582 | 97.994582% | 2.005418% | 97.987616%–98.001275% | $180,870.00 |
| 6 | 180.88× | 0.98000000 | 98.000000% | 2.000000% | 97.997851%–98.002501% | $542,640.00 |
| 7 | 633.08× | 0.98000000 | 98.000000% | 2.000000% | 97.999299%–98.000637% | $1,899,240.00 |
| 8 | 2,743.35× | 0.98000119 | 98.000119% | 1.999881% | 97.999969%–98.000281% | $8,230,050.00 |
| 9 | 16,460.08× | 0.98000000 | 98.000000% | 2.000000% | 97.999973%–98.000024% | $49,380,240.00 |
| 10 | 181,060.88× | 0.98000000 | 98.000000% | 2.000000% | 97.999998%–98.000002% | $543,182,640.00 |

### Final-stop exposure

| Difficulty | Max one cargo at $1,000 stake | Max round gross at $3,000 | Max round net profit | P(at least one reaches final) | P(all three reach final) |
| --- | --- | --- | --- | --- | --- |
| Easy | $19,600.00 | $58,800.00 | $55,800.00 | 14.262500000% | 1.250000000e-4 |
| Medium | $1,117,200.00 | $3,351,600.00 | $3,348,600.00 | 0.262927122% | 6.749715162e-10 |
| Hard | $15,193,920.00 | $45,581,760.00 | $45,578,760.00 | 0.019348597% | 2.683296850e-13 |
| Expert | $181,060,880.00 | $543,182,640.00 | $543,179,640.00 | 0.001623754% | 1.585639101e-16 |


These are finite but extremely large liabilities, not guaranteed or typical wins. The max-bet Expert maximum gross credit is **54,318,264,000 cents**. A single surviving Expert cargo at the maximum allocation can return **$181,060,880**. No simulated run is expected to sample all-three-final Expert survival, whose probability is approximately 1.586×10⁻¹⁶ per round.

## 5. Multiplier verification

**PASS within the pinned source and tested local adapters.** All 61 public table entries equal round(98/Sₛ), the requested two-decimal ladder. [public/app.js:1](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/public/app.js#L1) imports public/math.js for the difficulty cards, route, rules table and collected-stop display. [server/game.js:69](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/game.js#L69) uses multiplier() and payout() from that same module for settlement. publicRound() returns the same multiplier and calculated current cargo values; the client cannot submit a replacement multiplier for credit.

The audit forced survival in isolated engine fixtures solely to make every checkpoint reachable, then advanced and collected through the real settlement code. All **61 stops × 5 wager amounts (300, 301, 302, 3,001 and 300,000 cents) = 305 fixtures** matched the backend public value and ledger credit. This tests settlement, not RNG probabilities; the unmodified RNG simulation tests those separately. The independent BigInt calculation matched all 6,093,961 allowed individual stake/multiplier pairs.

The local browser showed a $3.01 split of $1.01/$1.00/$1.00, then stop-1 values $1.04/$1.03/$1.03 at 1.03×. Separate and combined collection returned $3.10, and both browser tabs showed a $1,000.09 balance. The browser verifier accepted the settled proof.

The hosted prototype's authenticated current frontend, backend bundle and cache alignment are **NOT VERIFIED**. Source sharing also does not solve future upgrade consistency: see F11.

## 6. Three-container optimal-strategy analysis

### Optimal stopping proof

For one still-onboard cargo of w cents at stop s, define Vₛ(w) as the greatest expected future gross credit conditional on its survival so far. At the final stop N, Vₙ(w)=g(w,N). At earlier collectable stops:

**Vₛ(w)=max[g(w,s), qₛ₊₁Vₛ₊₁(w)].**

At stop zero collection is prohibited, so the expected value is q₁V₁(w). Expanding the recursion gives **q₁V₁(w)=max₁≤t≤N Sₜg(w,t)**. Conditional on a cargo remaining alive at s, the best future target maximizes Sₜg(w,t) over t≥s. Randomizing between choices cannot improve on their maximum.

Other cargoes' observed outcomes provide no predictive information about this cargo's remaining route under independent HMAC domains. Decisions based on those observations are mixtures of conditional stopping choices, each bounded by the same Vₛ. Thus the total maximum expected credit is the **sum of the three individual maxima**. Collecting all intended subsets before each shared advance realizes that bound; there is no extra cost or forced advance for collecting one container.

This also covers adaptive collection based on previous losses, balance, or prior rounds, provided future seeds remain secret. Bet sizing across rounds creates a weighted average of achievable per-wager RTPs and cannot exceed the global maximum. The statement concerns expected returned money divided by money wagered; a lucky short session or a selectively reported sample can exceed 100% realized return.

An independent joint-state Bellman computation considered every collectable subset and every next-stop survivor subset for 36 representative mode/wager pairs, including uneven splits. It agreed with the factorized formula to 10⁻¹². The exact integer-score sweep covered all 299,701 total wagers in each difficulty.

### Maximum achievable RTP

| Difficulty | Best total wager | Container stakes | Optimal targets | Maximum RTP | Minimum house edge | Simulated RTP at this optimum |
| --- | --- | --- | --- | --- | --- | --- |
| Easy | $3.33 | $1.11/$1.11/$1.11 | 4/4/4 | 98.738739% | 1.261261% | 98.756018% |
| Medium | $3.36 | $1.12/$1.12/$1.12 | 5/5/5 | 98.355263% | 1.644737% | 98.304218% |
| Hard | $3.15 | $1.05/$1.05/$1.05 | 1/1/1 | 98.571429% | 1.428571% | 98.570859% |
| Expert | $3.36 | $1.12/$1.12/$1.12 | 1/1/1 | 98.214286% | 1.785714% | 98.311452% |


For Easy's maximum: each $1.11 cargo collected at 1.23× receives $1.37 after cent rounding. Stop-4 survival is 0.8, so RTP=0.8×137/111=548/555=98.738738…%. Medium's best stake returns 276 cents per surviving 112-cent cargo at stop 5; Hard returns 138 per 105-cent cargo at stop 1; Expert returns 220 per 112-cent cargo at stop 1.

No legitimate strategy in the current stake range reaches or exceeds 100%. A general sanity bound is also below 99%: multiplier rounding can add at most 0.005Sₛ to RTP, and payout rounding at w≥100 can add at most another 0.005Sₛ. The exhaustive optimum is tighter than that bound.

### Strategies compared

The following analytical table uses a $30 total wager, equal $10 cargo stakes. “Mid” is ceil(N/2). The adaptive strategy collects A at stop 1 if alive; targets B at Mid if all three survived stop 1, otherwise collects B at stop 1 if alive; targets C at Final. Its expectation was independently enumerated over all possible first-loss times for A/B/C. There is no hindsight or future-deck access in that strategy.

| Strategy | Easy RTP | Medium RTP | Hard RTP | Expert RTP |
| --- | --- | --- | --- | --- |
| All at first | 97.850000% | 97.750000% | 98.250000% | 98.000000% |
| All at final | 98.000000% | 98.000000% | 98.000000% | 98.000000% |
| A/B/C at 1/Mid/Final | 97.950000% | 97.912281% | 98.076109% | 97.998194% |
| A at 1; B/C at Final | 97.950000% | 97.916667% | 98.083333% | 98.000000% |
| Adaptive rule above | 97.945125% | 97.890373% | 98.115728% | 97.999549% |
| Optimal at $30 | 98.400000% | 98.245614% | 98.250000% | 98.052632% |


Separate cash-outs can slightly improve RTP relative to forcing all cargo to one stop when allocations differ by a cent. Example: at **$3.01 Easy**, A has 101 cents and optimally targets stop 7, while B/C have 100 cents and optimally target stop 4. Total RTP becomes **98.421927%**, compared with about **98.338870%** if all three target stop 4. At $3.02, A/B target 7 and C targets 4, yielding 98.443709%. These are legitimate rounding effects, not a result of one container revealing another's hazards.

## 7. RNG findings

### Implementation and evidence

[server/fairness.js:1](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/fairness.js#L1) imports node:crypto createHash, createHmac and randomBytes. newSeed() requests **32 random bytes**, encoded as 64 hex characters. Node documents randomBytes as a cryptographically strong source: [official Node crypto documentation](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptorandombytessize-callback). The audit ran on Node **v24.14.1**. Actual hosted runtime entropy health and configuration remain **NOT VERIFIED**.

The server hashes the raw seed bytes with SHA-256 and exposes only that commitment before the bet. beginRound requires the expected commitment, consumes the committed seed and current session nonce, increments the nonce, and creates a fresh independent next seed. Resetting the play wallet does not rewind the nonce or reuse an old seed. Clone/CAS persistence means an unsuccessful mutation does not commit the candidate round/nonce.

For each container, hazardDeck serializes **['cargo-v1', clientSeed, nonce, containerId, counter]** as JSON and applies HMAC-SHA-256 with the raw server seed as key. Counter starts at zero for each container and increments for every draw, including rejected draws. The first four digest bytes are read as an unsigned big-endian 32-bit value. Client seed length is limited to 1–128 characters; JSON encoding avoids ambiguous field concatenation. The round UUID and timestamps do not determine the hazards.

A descending Fisher–Yates shuffle uses bounds 20…2. For bound b, limit=floor(2³²/b)b; values at or above limit are discarded, and accepted values use value mod b. Each remainder has exactly limit/b preimages. This mapping is unbiased given uniform independent draw words. The rejection region is fewer than b values, so there is no floating-point probability threshold or range truncation in the hazard selection.

An in-memory copy of the exact production function, with only HMAC outputs mocked, was forced to receive 0xFFFFFFFF at the first bound-20 draw. It rejected that value and consumed 20 distinct counters rather than 19. All bounds 2…20 were checked arithmetically. This boundary test does not pretend the forced data is a natural RNG sample.

The first h shuffled positions are selected and sorted. A losing position is not sampled again on every advance. Distinct container IDs, client seeds, nonces and fresh server seeds separate streams. Difficulty itself is not in the HMAC message: the same seed/client/nonce/container would yield nested hazard selections across difficulties, but the implemented API permits only one locked difficulty for one consumed seed. No way to query alternative difficulties under an active round's same seed was found.

No Math.random, timestamp seed or client-generated financial outcome exists in the server RNG. The **Math.random** use in public/app.js:16 creates collision audio noise only. Browser crypto.randomUUID creates request IDs; the server generates the authoritative round IDs and seeds. Changing sound or animation randomness does not change payouts.

One hundred additional completed rounds with varied difficulties, uneven stakes and Unicode client seeds were independently reproduced with the browser Web Crypto verifier; all passed. Their server seeds and round IDs were unique in that sample. The million-round runs used newly generated seeds for every sample. A sample cannot prove that a CSPRNG will never repeat: security ultimately rests on the primitive, entropy source and secret storage.

### RNG limitations

No practical prediction method, modulo bias, exploitable inter-cargo correlation or preceding-round signal was found. This does not constitute a proof against all cryptanalysis or side channels. Host compromise, database access to plaintext unrevealed seeds, timing instrumentation of the actual host, backup rollback/seed reuse, and independent lab RNG testing were **NOT VERIFIED**. Server seed material is stored in the private session JSON and must remain inaccessible to players and unrelated services. No external RNG certification is claimed.

## 8. Simulation results

### Method

The main run generated 1,000,000 independent seed/nonce samples per mode, split into four 250,000-round chunks. It called the unchanged production **newSeed()** and **hazardDeck()** for A, B and C; this is at least **228 million HMAC evaluations**. Every route was evaluated at every permitted target stop. A $30 total wager ($10 per cargo) was used for return calculations; at that stake the actual cent formula is exactly the tabulated multiplier times stake. This avoids introducing a substitute Bernoulli generator or claiming four million HTTP wallet transactions were run.

Actual adapter settlement was tested separately in the adversarial and 305 settlement fixtures. The aggregate simulation examines hypothetical fixed-stop policies on the same sampled routes; results across stops within a mode therefore are not separate independent datasets. Modes used separate newly generated seeds. Cryptographic seeds were not retained as a replay dataset; chunk stream hashes and the exact source/harness identities were retained as provenance. A rerun produces a new statistical sample.

Run start: 2026-10-07T17:52:16.194Z; end: 2026-10-07T17:55:17.452Z. Eight worker threads were used. There were **zero invalid hazard decks** (wrong cardinality, repeated positions, or out-of-range positions).

### First-stop policy

| Mode | Theory RTP | Simulated RTP | Observed house edge | Any-payout hit rate | Zero-return rate | Net-loss rate |
| --- | --- | --- | --- | --- | --- | --- |
| Easy | 97.850000% | 97.858274% | 2.141726% | 99.988500% | 0.011500% | 14.240200% |
| Medium | 97.750000% | 97.773000% | 2.227000% | 99.665300% | 0.334700% | 38.575900% |
| Hard | 98.250000% | 98.249432% | 1.750568% | 98.448700% | 1.551300% | 57.842100% |
| Expert | 98.000000% | 98.096955% | 1.903045% | 87.552100% | 12.447900% | 49.912000% |


### Final-stop policy

| Mode | Theory RTP | Simulated RTP | Observed house edge | Any-payout hit rate | Zero-return / net-loss rate | Surviving cargoes / 3,000,000 |
| --- | --- | --- | --- | --- | --- | --- |
| Easy | 98.000000% | 97.798120% | 2.201880% | 14.236100% | 85.763900% | 149691 |
| Medium | 98.000000% | 96.935720% | 3.064280% | 0.260200% | 99.739800% | 2603 |
| Hard | 98.000000% | 97.241088% | 2.758912% | 0.019200% | 99.980800% | 192 |
| Expert | 98.000000% | 72.424352% | 27.575648% | 0.001200% | 99.998800% | 12 |


“Observed house edge” is 1 minus the sample RTP, not a new estimate of the implemented mathematical edge independent of sampling error. Final-stop positive returns exceed the wager even with only one survivor, so final-stop net-loss and zero-return rates coincide.

| Mode | Theory variance of return/wager | Sample variance | 95% Wilson RTP interval | Difference from theory (standard errors) | Maximum observed total gross at $30 |
| --- | --- | --- | --- | --- | --- |
| Easy | 6.082533 | 6.069540 | 97.316%–98.282% | -0.819 | $588.00 |
| Medium | 364.631867 | 360.326331 | 93.284%–100.730% | -0.557 | $22,344.00 |
| Hard | 4,963.027067 | 4,923.965456 | 84.425%–112.002% | -0.108 | $151,939.20 |
| Expert | 59,146.234000 | 43,710.198493 | 41.431%–126.602% | -1.052 | $1,810,608.80 |


Variance is in squared units of return divided by total wager; dollar variance at $30 is 900 times that value. The Wilson interval is formed from cumulative survival counts over three million cargo routes and transformed into RTP. It assumes independent pseudorandom cargo outcomes. These are per-row intervals, not simultaneous intervals across all 61 stops.

**Expert tail investigation:** expected final survivors are 3,000,000/184,756 ≈ 16.2376; the sample contained 12 (A=5, B=4, C=3). Its 72.424352% sample RTP differs from 98% by only −1.052 theoretical standard errors. Its 95% interval is approximately 41.43%–126.60%. The lower sample variance also follows from under-sampling this rare tail. This is consistent with the analytical model; it does not show a 27.58% true house edge or validate the tail to commercial precision. Roughly 2.27 billion independent Expert rounds would be needed for an approximate 95% RTP half-width of one percentage point using the theoretical variance and normal large-sample planning formula; analytical mathematics remains essential.

### Final-stop payout distribution

For the $30 total wager, k surviving cargoes return k×$10×final multiplier. Counts below include all one million rounds, including voyages where every cargo would have been lost earlier.

| Mode | 0 survivors: count / payout | 1 survivor: count / payout | 2 survivors: count / payout | 3 survivors: count / payout |
| --- | --- | --- | --- | --- |
| Easy | 857,639 / $0.00 | 135,157 / $196.00 | 7,078 / $392.00 | 126 / $588.00 |
| Medium | 997,398 / $0.00 | 2,601 / $11,172.00 | 1 / $22,344.00 | 0 / $33,516.00 |
| Hard | 999,808 / $0.00 | 192 / $151,939.20 | 0 / $303,878.40 | 0 / $455,817.60 |
| Expert | 999,988 / $0.00 | 12 / $1,810,608.80 | 0 / $3,621,217.60 | 0 / $5,431,826.40 |


The complete fixed-stop theoretical distribution at every row is the Binomial formula in section 3. The next tables supply the empirical count at each of its four possible payout points, along with RTP, hit/zero-return rates, variance, and deviation from theory. The per-row maximum is the greatest observed k with a nonzero count times $10 times that row's multiplier; the absolute maximum is the k=3 point even where it was not sampled.

### Easy — every simulated stop ($30 wager)

| Stop | RTP | Observed HE | Hit rate | Zero return | Counts k=0/1/2/3 | Sample variance | RTP z |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 97.85827% | 2.14173% | 99.98850% | 0.01150% | 115/7127/135160/857598 | 0.01677 | 0.638 |
| 2 | 98.13008% | 1.86992% | 99.90280% | 0.09720% | 972/26891/242474/729663 | 0.03555 | 1.593 |
| 3 | 97.76273% | 2.23727% | 99.66720% | 0.33280% | 3328/57190/325304/614178 | 0.05611 | 0.537 |
| 4 | 98.41722% | 1.58278% | 99.20290% | 0.79710% | 7971/95579/384509/511941 | 0.08053 | 0.606 |
| 5 | 98.25432% | 1.74568% | 98.43810% | 1.56190% | 15619/140198/422648/421535 | 0.10710 | 0.132 |
| 6 | 97.99151% | 2.00849% | 97.32400% | 2.67600% | 26760/189060/441782/342398 | 0.13688 | -0.229 |
| 7 | 98.10566% | 1.89434% | 95.73580% | 4.26420% | 42642/239454/444047/273857 | 0.17260 | -1.066 |
| 8 | 97.79821% | 2.20179% | 93.62130% | 6.37870% | 63787/287985/432702/215526 | 0.21215 | -0.039 |
| 9 | 97.89887% | 2.10113% | 90.91730% | 9.08270% | 90827/334446/408646/166081 | 0.26098 | -0.022 |
| 10 | 97.97080% | 2.02920% | 87.52900% | 12.47100% | 124710/375811/374695/124784 | 0.31970 | -0.516 |
| 11 | 98.05945% | 1.94055% | 83.36880% | 16.63120% | 166312/409011/333600/91077 | 0.39187 | -0.648 |
| 12 | 97.97370% | 2.02630% | 78.40540% | 21.59460% | 215946/432465/287554/64035 | 0.48005 | -0.379 |
| 13 | 98.00597% | 1.99403% | 72.54460% | 27.45540% | 274554/443778/238718/42950 | 0.59459 | 0.077 |
| 14 | 98.09913% | 1.90087% | 65.70230% | 34.29770% | 342977/440950/189177/26896 | 0.74819 | -0.010 |
| 15 | 97.95910% | 2.04090% | 57.79780% | 42.20220% | 422022/421827/140593/15558 | 0.95987 | -0.417 |
| 16 | 97.97583% | 2.02417% | 48.80630% | 51.19370% | 511937/384275/95787/8001 | 1.27949 | -0.214 |
| 17 | 97.79981% | 2.20019% | 38.55440% | 61.44560% | 614456/325168/56986/3390 | 1.80865 | -1.116 |
| 18 | 97.95492% | 2.04508% | 27.09690% | 72.90310% | 729031/243042/26961/966 | 2.87760 | -0.266 |
| 19 | 97.79812% | 2.20188% | 14.23610% | 85.76390% | 857639/135157/7078/126 | 6.06954 | -0.819 |

### Medium — every simulated stop ($30 wager)

| Stop | RTP | Observed HE | Hit rate | Zero return | Counts k=0/1/2/3 | Sample variance | RTP z |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 97.77300% | 2.22700% | 99.66530% | 0.33470% | 3347/56947/325465/614241 | 0.05605 | 0.970 |
| 2 | 98.06967% | 1.93033% | 97.71480% | 2.28520% | 22852/173115/437703/366330 | 0.12702 | 0.183 |
| 3 | 97.79216% | 2.20784% | 93.43090% | 6.56910% | 65691/291533/430980/211796 | 0.21562 | -0.697 |
| 4 | 98.20240% | 1.79760% | 86.86100% | 13.13900% | 131390/382399/367996/118215 | 0.33266 | -0.749 |
| 5 | 98.13325% | 1.86675% | 78.34420% | 21.65580% | 216558/433546/286487/63409 | 0.48276 | -0.733 |
| 6 | 97.93361% | 2.06639% | 68.50220% | 31.49780% | 314978/445320/207420/32282 | 0.68035 | -1.101 |
| 7 | 97.92712% | 2.07288% | 57.94260% | 42.05740% | 420574/423087/140745/15594 | 0.95444 | -1.695 |
| 8 | 97.79271% | 2.20729% | 47.36950% | 52.63050% | 526305/377091/89387/7217 | 1.33639 | -2.094 |
| 9 | 97.67034% | 2.32966% | 37.35080% | 62.64920% | 626492/317286/53144/3078 | 1.88547 | -2.301 |
| 10 | 97.69386% | 2.30614% | 28.30130% | 71.69870% | 716987/252388/29460/1165 | 2.71212 | -1.856 |
| 11 | 97.65569% | 2.34431% | 20.44980% | 79.55020% | 795502/189095/15028/375 | 4.01070 | -1.716 |
| 12 | 97.47770% | 2.52230% | 13.95170% | 86.04830% | 860483/132555/6858/104 | 6.16623 | -2.098 |
| 13 | 97.36345% | 2.63655% | 8.87270% | 91.12730% | 911273/85970/2734/23 | 10.04616 | -2.002 |
| 14 | 97.80341% | 2.19659% | 5.16060% | 94.83940% | 948394/50690/912/4 | 17.89515 | -0.464 |
| 15 | 97.80714% | 2.19286% | 2.60230% | 97.39770% | 973977/25782/241/0 | 36.13520 | -0.321 |
| 16 | 98.22981% | 1.77019% | 1.05100% | 98.94900% | 989490/10469/41/0 | 91.19779 | 0.241 |
| 17 | 96.93572% | 3.06428% | 0.26020% | 99.73980% | 997398/2601/1/0 | 360.32633 | -0.557 |

### Hard — every simulated stop ($30 wager)

| Stop | RTP | Observed HE | Hit rate | Zero return | Counts k=0/1/2/3 | Sample variance | RTP z |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 98.24943% | 1.75057% | 98.44870% | 1.55130% | 15513/140566/422342/421579 | 0.10710 | -0.017 |
| 2 | 97.72188% | 2.27812% | 91.04010% | 8.95990% | 89599/332647/409606/168148 | 0.25796 | -1.848 |
| 3 | 98.03444% | 1.96556% | 78.27590% | 21.72410% | 217241/433419/285897/63443 | 0.48324 | -2.153 |
| 4 | 97.93428% | 2.06572% | 62.94920% | 37.05080% | 370508/437045/170125/22322 | 0.81498 | -1.207 |
| 5 | 97.88064% | 2.11936% | 47.55080% | 52.44920% | 524492/377943/90318/7247 | 1.33044 | -1.104 |
| 6 | 97.94591% | 2.05409% | 33.92970% | 66.07030% | 660703/293647/43459/2191 | 2.15919 | -0.423 |
| 7 | 98.06434% | 1.93566% | 22.89020% | 77.10980% | 771098/209281/19039/582 | 3.54303 | 0.152 |
| 8 | 97.78859% | 2.21141% | 14.50840% | 85.49160% | 854916/137346/7606/132 | 5.94985 | -0.778 |
| 9 | 97.97492% | 2.02508% | 8.66780% | 91.33220% | 913322/84010/2648/20 | 10.43238 | -0.103 |
| 10 | 97.71602% | 2.28398% | 4.78340% | 95.21660% | 952166/47048/783/3 | 19.32256 | -0.633 |
| 11 | 98.31301% | 1.68699% | 2.42870% | 97.57130% | 975713/24116/171/0 | 39.10460 | 0.496 |
| 12 | 98.95040% | 1.04960% | 1.09120% | 98.90880% | 989088/10883/29/0 | 88.98603 | 1.011 |
| 13 | 100.44869% | -0.44869% | 0.41600% | 99.58400% | 995840/4155/5/0 | 241.82811 | 1.594 |
| 14 | 101.54603% | -1.54603% | 0.12020% | 99.87980% | 998798/1201/1/0 | 857.55070 | 1.233 |
| 15 | 97.24109% | 2.75891% | 0.01920% | 99.98080% | 999808/192/0/0 | 4,923.96546 | -0.108 |

### Expert — every simulated stop ($30 wager)

| Stop | RTP | Observed HE | Hit rate | Zero return | Counts k=0/1/2/3 | Sample variance | RTP z |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 98.09695% | 1.90305% | 87.55210% | 12.44790% | 124479/374641/375797/125083 | 0.31976 | 1.714 |
| 2 | 98.26345% | 1.73655% | 55.63380% | 44.36620% | 443662/413966/129028/13344 | 1.03438 | 2.075 |
| 3 | 98.05571% | 1.94429% | 28.38270% | 71.61730% | 716173/252781/29950/1096 | 2.72171 | 0.338 |
| 4 | 98.45223% | 1.54777% | 12.49910% | 87.50090% | 875009/119427/5488/76 | 7.10009 | 1.701 |
| 5 | 97.92101% | 2.07899% | 4.79280% | 95.20720% | 952072/47133/793/2 | 19.36540 | -0.167 |
| 6 | 98.54945% | 1.45055% | 1.62660% | 98.37340% | 983734/16187/79/0 | 59.02193 | 0.717 |
| 7 | 98.80269% | 1.19731% | 0.46730% | 99.53270% | 995327/4664/9/0 | 208.32540 | 0.559 |
| 8 | 101.04673% | -1.04673% | 0.11040% | 99.88960% | 998896/1103/1/0 | 924.67317 | 1.018 |
| 9 | 90.53044% | 9.46956% | 0.01650% | 99.98350% | 999835/165/0/0 | 4,966.30804 | -1.019 |
| 10 | 72.42435% | 27.57565% | 0.00120% | 99.99880% | 999988/12/0/0 | 43,710.19849 | -1.052 |

### Correlation and pattern checks

| Mode | Largest \|survival/RTP z\| over stops | Largest \|hazard-position z\| | Largest \|pair-correlation z\| where powered | Lag-1 A correlation | Repeated adjacent A decks: observed / expected |
| --- | --- | --- | --- | --- | --- |
| Easy | 1.593 | 2.620 | 2.661 | -0.0004551 | 49896 / 49,999.800 |
| Medium | 2.301 | 2.708 | 3.118 | 0.0005226 | 904 / 877.189 |
| Hard | 2.153 | 3.039 | 2.887 | 0.0006888 | 72 / 64.499 |
| Expert | 2.075 | 2.640 | 1.970 | -0.0002692 | 8 / 5.413 |


The position checks cover all 20 positions for all three cargoes in every mode. Pair checks use A/B, A/C and B/C survivor indicators; reported standardized correlations are sqrt(N) times the binary Pearson correlation, restricted to stages with expected both-survive and both-fail cell counts of at least 10. Across the supported stages no absolute correlation exceeded 0.003118. Rare final stages in Medium/Hard/Expert do not have enough joint survivors for a powerful independence test; those particular tail correlations are **NOT VERIFIED statistically**. Their theoretical independence comes from domain-separated cryptographic streams.

No explored marginal, RTP or adequately populated correlation statistic exceeded an absolute z of 3.118, across hundreds of comparisons. With this many comparisons, isolated values around three standard errors are not compelling evidence of a defect. An exploratory conservative 4.5-standard-error screen produced no alerts. This is a diagnostic screen, not a formal RNG certification battery.

Repeated hazard decks are expected because the output space is small, especially Easy's 20 possible decks. Adjacent A-deck equality has probability 1/C(20,h). Observed repeat counts were consistent with those expectations; repeats do not establish reused server seeds. The lag-1 analysis excludes the three boundaries between independently executed chunks. No useful previous-round signal was detected by these tests. Higher-order correlations and exhaustive cryptanalytic pattern searches are **NOT VERIFIED**.

## 9. Cash-out and financial exploit findings

### Tests and results

| Attack / calculation | Evidence and result |
| --- | --- |
| Duplicate bet | 20 concurrent copies of one exact request per adapter: one debit, all requests returned success/current replay state. |
| Duplicate advance | 20 concurrent identical advances per adapter: one stop advancement. |
| Double cash-out | 50 concurrent identical collect-all requests per adapter: exactly one credit per cargo; three credits total. |
| Fresh-ID repeat / body change | Collected/lost cargo could not be credited again; changed body under an existing action ID rejected with 409. |
| Cash-out during elimination | 40 races per adapter with the next stop forced to eliminate all remaining cargo: exactly one action succeeded, the other returned 409. No cargo was both lost and collected. |
| Competing tabs / delayed requests | Stale revision rejected; fresh browser tab restored secured cargo; refreshed tab restored final payout. |
| Partial collection and subsequent loss | A remained collected and credited after B then C were lost; old exact cash-out replay did not add a credit. |
| Actual TCP disconnect | Response was delayed after commit and the client socket destroyed. Client received ECONNRESET; balance/ledger retained one settlement; exact retry was replayed without extra credit. |
| Save failure before commit | Local disk-write failure and Worker pre-update failure returned 500 with no persisted cargo/ledger/balance change; exact retry succeeded. |
| Uncertain result after commit | Injected Worker post-update error returned 500; reconnect showed settled state and identical retry replayed. |
| Frontend/API manipulation | Forged step, multiplier, payout, balance, hazards, status, seed and difficulty fields did not override server results. Stop-zero collection rejected. |
| Invalid wagers | Negative, zero, below-minimum, fractional, excessive, unsafe, string, null, object and array values rejected without persisted mutation. |
| Cent conservation | All 299,701 allowed total wagers split exactly, with maximum allocation difference of one cent. |
| Rounding arithmetic | All 6,093,961 allowed individual stake/table pairs matched BigInt half-up settlement. |
| Maximum settlement | Forced-survival fixtures at $3,000 reached every final payout, including the full Expert exposure, and reconciled the balance. |
| Session isolation / cross-origin | Foreign session access rejected; tested cross-origin POSTs returned 403; oversized bodies returned 413. |
| Ledger invariant | For tested ordinary flows, starting balance plus all signed ledger entries equaled final balance, with no repeated ledger IDs. |


Concurrency tests use actual local HTTP handling and the actual Worker function with an in-memory SQLite implementation of its database interface. The Worker tests exercise its revision compare-and-swap statement; they do **not** reproduce every distributed Cloudflare failure mode. Forced hazard fixtures are clearly test-only and were used for reproducible edge-case races. A local file reload matched saved state; abrupt machine power loss and remote database failover were **NOT VERIFIED**.

At the largest permitted individual stake, the greatest multiplication is 100,000×18,106,088=1,810,608,800,000, well below Number.MAX_SAFE_INTEGER. Adding 50 is also safe for these inputs. payout() validates the integer product, and entry() validates the new balance. Floating-point representation of dollar strings is not used for settlement; the browser parses decimal text into integer cents, and the backend validates cents independently. No fractional-cent wallet credit or stake-splitting money creation was found. The bound applies to the current stake and multiplier limits; changing them requires a new safety analysis.

### F01 — HIGH — Anonymous play-wallet creation/refill lacks a real-money boundary

**Description:** new sessions receive $1,000 of play balance, and the authenticated-by-cookie reset endpoint resets a settled wallet to that amount without operator authorization. There is no server-bound operator/player/currency identity or launch-token validation.

**Evidence:** both adapters accepted POST /api/reset after a forced $3.01 all-loss round and restored 100,000 cents from 99,699. A new cookie also creates a new funded play session. The behavior is intentional for the prototype, not a discovered theft of real funds.

**Code:** [server/game.js:9](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/game.js#L9), createSession(); [server/game.js:76](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/game.js#L76), resetWallet(); [server/app.js:41](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/app.js#L41) and [server/worker.js:26](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/worker.js#L26), session creation; Worker line 50 and local line 70, reset routing.

**Possible exploit:** if a later connector accepts these balances or refill entries as withdrawable money, a user can mint value through new sessions/refills. Current amounts are play money only.

**Recommended fix:** establish an explicit demo/real-money mode boundary; remove/reject refill and free initial credits in real-money mode; authenticate launches and bind player, operator, currency, game version and limits server-side. Keep the demo separate.

### F02 — HIGH — External wallet transaction lifecycle is absent

**Description:** the engine writes only an internal play balance and ledger. No external wager-debit acknowledgement, win-credit acknowledgement, rollback/void state, transaction-status query, durable delivery queue, or reconciliation process exists.

**Evidence:** all financial updates terminate in entry(); adapters persist one session object. The repository contains no operator wallet connector. Source and docs/INTEGRATION.md explicitly describe this as unfinished. Internal duplicate protection passed but does not establish distributed exactly-once financial effect.

**Code:** [server/game.js:12](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/game.js#L12), entry(); beginRound() lines 39–46; collectRound() lines 68–73; [server/worker.js:47](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/worker.js#L47); [docs/INTEGRATION.md:12](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/docs/INTEGRATION.md#L12).

**Possible exploit/failure:** a naive connector can accept a bet without a confirmed debit, retry uncertain debits under new IDs, lose credits after a crash, or apply a rollback after a win without reconciling the round.

**Recommended fix:** use a durable transaction state machine/outbox with stable transaction IDs and amount/currency fingerprints; reserve or confirm the wager before allowing gameplay; retry ambiguous operations with the same IDs; distinguish pending, acknowledged, failed and reversed transactions; reconcile operator and game ledgers. Define how three partial credits and final round closure map to the partner contract. Exact endpoint mapping: **NOT VERIFIED — REQUIRES SAYCOVE INTEGRATION SPEC**.

### F03 — HIGH — Growing session rows can block financial settlement

**Description:** every completed round, event, ledger entry, receipt and unrevealed next seed remains inside one session JSON value. Nothing removes or archives old state. Every mutation rewrites it.

**Evidence:** Cloudflare documents a maximum string/BLOB/table-row size of **2,000,000 bytes** in [D1 limits](https://developers.cloudflare.com/d1/platform/limits/). The source has no retention or size safeguard. In an SQLite-backed harness with that documented bound injected, approximately 888 short completed histories plus 2 additional attempted voyages produced an HTTP 500 during **collect**, at a stored body of 1,999,465 bytes. A separate explicit boundary fixture at 1,999,734 bytes failed collect-all with 500, left the round active and credited zero cents. The exact round count depends on events, seed lengths and IDs; it is not a fixed product threshold. The real Cloudflare limit was not load-tested against the private site.

The capacity fixtures replenished a test balance and synthesized receipt records. They establish serialization/limit failure, not a measured number of live rounds or a production load test.

**Code:** [db/schema.ts:2](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/db/schema.ts#L2); [server/worker.js:14](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/worker.js#L14) and line 53; [server/game.js:10](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/game.js#L10), rounds/ledger/receipts; snapshot()'s last-20 display limit does not prune stored history.

**Possible exploit/failure:** ordinary continued play or automated repeated actions eventually causes all new mutations, including collection, to fail. No duplicate payout occurs, but funds/cargo can be stranded until operational repair.

**Recommended fix:** split rounds, immutable transactions and receipts into separate indexed tables; keep the live session small; define retention/archival without deleting idempotency protection needed for retries; add capacity monitoring and recovery. Test settlement at storage limits and guarantee closure of already-accepted rounds.

### F04 — HIGH — Exposure is not controlled

**Description:** Expert permits 181,060.88× per surviving cargo with a $3,000 total bet and no maximum payout, reserved exposure or balance-sheet limit.

**Evidence:** the mathematical bound and maximum-stake forced-survival settlement both permit **$543,182,640** total gross return. This is an existing rule, not a rounding overflow or an advantage-player exploit.

**Code:** [public/math.js:6](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/public/math.js#L6) and line 9; [server/game.js:69](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/game.js#L69).

**Possible exploit/failure:** a legitimate rare result, particularly one $181,060,880 cargo, creates an obligation beyond an unprepared operator/provider's funded limits. A payout cap imposed only after the result would violate the accepted game rules.

**Recommended fix:** agree and enforce an approved exposure model before accepting wagers: permitted stake by mode, funding/reserves, and any disclosed max-win rule. A cap or math alteration requires recalculated RTP, optimal-strategy analysis and updated player rules. Do not silently cap the current prototype.

### F05 — HIGH — Unfinished-round recovery depends on an anonymous cookie

**Description:** normal refresh restores state, but losing the session credential cannot be recovered through an operator/player identity. A final-stop survivor remains uncredited until an explicit collection. There is no timed settlement, operator recovery endpoint or abandonment policy.

**Evidence:** createSession ties ownership to a random browser cookie. Requests without the owning session cannot access a round. The last advance leaves surviving cargo onboard; advanceRound then rejects further advances, and only collectRound resolves it. No recovery job exists in the source. Ordinary refresh and retry recovery passed.

**Code:** [server/app.js:39](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/app.js#L39); [server/worker.js:24](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/worker.js#L24); [server/game.js:19](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/game.js#L19), activeRound()/finish()/advanceRound()/collectRound().

**Possible exploit/failure:** cookie loss, long absence or a crash before final collection can leave a valid wager unresolved and prevent support from restoring it through an operator account. Abandoning a negative-EV round does not produce a player edge, but it creates unsettled obligations.

**Recommended fix:** persist ownership by authenticated player/operator, support renewed launch sessions and recovery, define a disclosed policy for abandoned choices, and automatically or operationally close final-port rounds where no risk decision remains. Obtain agreement for expirations/voids rather than inventing them.

## 10. Security/player-edge findings

### Explicit player-edge answer

**Can a skilled player, bot or AI achieve RTP higher than the intended theoretical RTP?**

**Yes relative to a blanket nominal 98% target:** choosing favorable stops and cent denominations raises achievable RTP to the maxima in section 6, globally 98.738738%. **No method was found to exceed the correctly calculated optimal RTP of the implemented game.** No tested legitimate strategy reached 100%, and no tested API/timing/replay route produced extra credit. This conclusion does not extend to future wallet integration, production compromise, promotions, bonuses or other unimplemented rules.

Fast requests do not create a time advantage because no independent elimination clock runs. Concurrent advance/collect calls compete for one revision; whichever commits first defines the result, and the loser must obtain fresh state before a new decision. The server does not accept a client-supplied payout, stage, hazard route or balance. Changing JavaScript or animation can change presentation or request timing, but cannot change the settled multiplier or revive a lost cargo through the implemented API.

### Future-result leakage

**PASS for inspected source and tested local responses; live authenticated deployment NOT VERIFIED.** publicRound() constructs an explicit public object and includes seed/decks only when the whole round is settled. snapshot() returns nextSeedHash, not nextSeed. A settled prior seed is independent of the next round's new seed. Active GET /api/session, POST replies, owned round GET and replay snapshots were inspected. The captured local-browser trace contained 8 active-round responses and no server seed or hazard-deck field in any of them. Separate adversarial API checks also searched for the actual private seed strings in active responses.

The browser receives the result of an **already-committed advance before its animation finishes**. That is expected server-authoritative presentation, not an opportunity to cash out retroactively: a lost cargo is already lost in the backend, and a stale collect request fails. Animation does not reveal the next unattempted stop. Browser source contains no financial WebSocket implementation; gameplay uses fetch. WebSocket packet capture is therefore not applicable to the source implementation. Actual hosted proxy-injected traffic and browser heap/debugger inspection beyond the available API/DOM observations are **NOT VERIFIED**.

Relevant code: [server/game.js:80](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/game.js#L80), publicRound()/snapshot(); [public/app.js:80](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/public/app.js#L80), api()/action(); [public/scene.js](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/public/scene.js); [public/collision.js](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/public/collision.js). The static local allowlist excludes server files, data/state.json and other private paths. The hosted build copies public/ assets and bundles the Worker separately; actual hosting access configuration was not inspected or changed.

### F06 — MEDIUM — Actual RTP varies with stop, wager and strategy

**Description:** the 98% nominal factor is altered by multiplier rounding and then payout rounding. The favorable choices are available to ordinary players and automation.

**Evidence:** all four modes have achievable maxima above 98%; Easy reaches 98.738738% at $3.33/stop 4. The exhaustive stage/wager range includes returns below 98% too. docs/FAIRNESS.md already cautions about both rounding layers, so this is a commercial math/disclosure decision, not a hidden contradiction of that document.

**Code:** [public/math.js:3](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/public/math.js#L3), payout() lines 14–18; [docs/FAIRNESS.md](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/docs/FAIRNESS.md).

**Possible exploit:** players can reduce the nominal house edge through a favorable cent denomination and stop selection. They cannot turn it positive under the audited rules.

**Recommended fix:** approve and publish the actual strategy-dependent math and wager rules; make partner economics use the optimal-player edge. If a constant target RTP is required, design revised math/rounding rules and re-audit them before changing the game.

### F07 — HIGH — Local file storage is not a production multi-process ledger

**Description:** Store clones process-local memory and overwrites one JSON file with a rename. There is no cross-process lock or explicit fsync of the file/directory. Its comment and integration documentation explicitly restrict it to local, single-process use.

**Evidence:** two Store instances were opened against one test directory. The first wrote a balance of 99,900 cents; a stale write by the second restored 100,000 cents on disk. The Worker uses a revision CAS instead and did not show this lost-update behavior in the tested concurrency cases. Power-cut durability was **NOT VERIFIED**.

**Code:** [server/store.js:4](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/store.js#L4), constructor()/transaction(); [server/index.js:10](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/index.js#L10); [docs/INTEGRATION.md:13](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/docs/INTEGRATION.md#L13).

**Possible exploit/failure:** running more than one Node process against the same wallet file can overwrite debits, credits or settled state and invalidate idempotency history. A machine crash may lose a recently acknowledged write without a durability guarantee.

**Recommended fix:** prohibit this store in real-money deployments; use transactional production persistence with uniqueness constraints and defined recovery semantics. Preserve the local store for the demo only. Validate the selected hosted database's durability and failover separately.

### F08 — MEDIUM — Proof verification does not validate all reported metadata

**Description:** verifyRound correctly reconstructs hazards, event outcomes, stakes and core credits, but it does not reject unsupported proof.algorithm values or verify all public metadata.

**Evidence:** a valid completed proof was edited to change proof.algorithm, top-level multiplier100, round id and a container's valueCents. verifyRound still returned valid:true. Tampering with core returned totals, event outcomes or the seed was rejected by the existing tests. The verifier does not claim to authenticate an operator wallet payment or externally anchor a round ID.

**Code:** [public/fairness.js:5](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/public/fairness.js#L5), verifyRound(); imported current MODES at line 1 and returned success at line 54.

**Possible exploit:** an altered exported report can retain a green verification result while showing false unvalidated identifiers/display values. This does not cause the backend to pay more; it can confuse dispute/support evidence.

**Recommended fix:** enforce a strict versioned proof schema and supported algorithm; verify/recompute all displayed financial metadata; require exactly one instance of each cargo; distinguish mathematical consistency from authenticated operator transaction evidence. Pin the original commitment externally if the proof is used beyond a live session.

### F09 — MEDIUM — Resource and session controls are incomplete

**Description:** the application has body-size limits but no per-player/request rate limit, server-side session expiration, maximum anonymous-session count, or bounded history policy. The cookie has a 30-day Max-Age, but the backend record itself has no expiresAt check.

**Evidence:** GET /api/session creates another persisted funded session whenever no recognized cookie is supplied. The single-table schema has no expiry column, and the source has no rate limiter or cleanup job. A production gateway might add controls; that is **NOT VERIFIED**. No denial-of-service attack was run against the private site.

**Code:** [server/worker.js:24](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/worker.js#L24), session creation and load; [server/app.js:39](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/app.js#L39); [db/schema.ts:2](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/db/schema.ts#L2).

**Possible exploit/failure:** automation can create many wallets or generate unbounded storage/work; an old stolen valid session token can remain accepted if the stored record still exists. This is an availability/session-control issue, not demonstrated RNG prediction.

**Recommended fix:** authenticate production launches, enforce server-side expiration/revocation and quotas, rate-limit relevant endpoints, monitor resource use and implement retention without losing financial evidence. Verify gateway controls rather than assuming they exist.

### F10 — LOW — Idempotency keys have avoidable edge cases

**Description:** receipts uses a normal JavaScript object and truthy property lookup. The valid actionId “constructor” collides with an inherited property. Fingerprints also depend on JSON object property order.

**Evidence:** a fresh reset request using actionId=constructor returned 409 “Action ID was reused for a different request.” An exact semantic duplicate of a completed collect request with reordered JSON keys also returned 409 rather than replayed:true. Neither request added a credit.

**Code:** [server/game.js:10](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/game.js#L10), receipts:{}; [server/app.js:59](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/app.js#L59); [server/worker.js:44](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/worker.js#L44).

**Possible exploit/failure:** legitimate integrations with non-UUID IDs or serializers that reorder properties can see false conflicts after an uncertain response. The risk is failed recovery/reconciliation, not duplicate payment. The current browser reuses the exact payload and normally avoids it.

**Recommended fix:** use a dedicated receipt table or own-property lookup with a safe map; strictly define allowed action IDs; fingerprint canonical validated semantic fields, including route/round, operation, amount and currency as applicable. Keep stable immutable transaction receipts for external reconciliation.

### F11 — HIGH — Round math is not immutable across upgrades

**Description:** accepted rounds store difficulty and an algorithm label, but not a rules/math version that selects immutable wager-time settlement tables. collectRound and proof verification read the current MODES table.

**Evidence:** in an isolated process, a round accepted under Easy's 1.03× first multiplier was advanced, then the in-memory table was changed to 1.04× to model a deployment/configuration change. Collection paid 104 cents per 100-cent cargo rather than the original 103. The table was immediately restored; source files were unchanged. An equivalent code deployment between wager and collection would load the new table for persisted rounds.

**Code:** [server/game.js:40](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/server/game.js#L40), round fields; collectRound() line 69; publicRound() line 82; [public/fairness.js:25](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/public/fairness.js#L25) and line 44; [public/math.js:19](https://github.com/sarimichael/cargo-game/blob/25d5181fbd82abbd22aaea4b32f546e94f9c3602/public/math.js#L19).

**Possible exploit/failure:** a live math update silently changes the value of already-accepted wagers or makes historical proofs unverifiable. A player aware of a favorable rollout might delay collection; no such live rollout or current remote table-edit exploit was demonstrated.

**Recommended fix:** bind every round to a reviewed immutable math/rules/settlement version at wager acceptance; retain versioned tables and verifier implementations for history. Refuse incompatible migrations and test active-round continuation across deployments.

## 11. Saycove integration blockers

The following assessment distinguishes capabilities demonstrated inside the play-money system from real-money requirements that remain absent or untested.

| Capability | Cargo evidence/status | Before a real-money integration |
| --- | --- | --- |
| Unique round IDs | Server crypto.randomUUID; 100 extra sampled IDs unique; no user-supplied round ID. | Persist under a unique constraint with operator/player/game version ownership. |
| Unique transaction IDs | Internal IDs are roundId:bet and roundId:collect:A/B/C; entry rejects a duplicate within the session. | Separate immutable transaction records with database uniqueness and partner mapping. |
| Wager debit | One internal debit tested; balance validation and amount conservation passed. | External acknowledged debit/reservation and uncertain-debit recovery. |
| Payout credit | One internal credit per cargo tested; secured cargo remains paid. | Durable external partial-win/final-win delivery and round-close mapping. |
| Retries / idempotency | Exact retry receipts and revision CAS passed; F10 documents format edge cases. | Stable IDs, canonical fingerprints, receipt retention and reconciliation across services. |
| Rollback / void | Absent; clone/CAS rollback on a failed local mutation is not an operator rollback protocol. | Explicit compensating transactions and a defined state machine. |
| Disconnect / reconnect | Same-cookie browser refresh and post-commit disconnect recovery passed. | Authenticated renewal after cookie/session loss; signed launch ownership. |
| Unfinished-round recovery | Persisted active round exists, but no final auto-credit, expiry or support recovery path. | Durable reattachment/closure rules and recovery jobs; fix F03/F05. |
| Round history | All rounds persisted; latest 20 summaries displayed; owned round GET available. | Paginated, indexed, retained and exportable history without growing session blobs. |
| Transaction history | Internal mutable JSON ledger exists; no dedicated authenticated transaction API/export. | Immutable searchable ledger, access control and daily reconciliation. |
| Server authority | Shared engine controls validated wager, RNG, stop, eligibility, multiplier and credits. | Preserve authority through external debit/credit state transitions. |
| Math/version/exposure | Analytically reviewed current ladder, but no pinned round math or approved win limit. | Fix F04/F06/F11 and obtain reviewed production math approval. |
| Operational readiness | No source-level rate/retention controls, incident tooling or tested production failover. | Monitor pending settlements, errors, storage, drift and audit evidence. |
| Saycove API/auth/signatures/currency/embedding | NOT VERIFIED — REQUIRES SAYCOVE INTEGRATION SPEC | Agree signed launch and wallet schemas, currencies/minor units, retry/rollback semantics, limits, errors and test cases. |


The local server's Host/origin restrictions and frame-ancestors 'none' are intentional local-demo restrictions; a real operator launch must have an explicitly reviewed HTTPS/origin/frame policy. The hosted cookie is HttpOnly/SameSite=Strict and Secure on HTTPS. Cross-site embedded-session behavior is not established and must not be weakened casually to make an iframe work. Saycove's intended launch/embedding flow is **NOT VERIFIED — REQUIRES SAYCOVE INTEGRATION SPEC**.

Jurisdictions, operator licensing, required laboratory scope and production acceptance criteria were not provided. Their applicability and compliance are **NOT VERIFIED**. This report is an engineering pre-integration audit, not independent casino certification or a guarantee of acceptance.

## 12. Required fixes

No fixes below have been applied to the production game. This report records confirmed behavior and recommended work.

1. **Separate demo funding from real money (F01)** and implement authenticated launch ownership, renewal, expiration, currency and limits. Acceptance evidence: a real-money session cannot gain funds from a new cookie or reset endpoint; unauthorized/cross-player launches fail.
2. **Implement the durable external wallet lifecycle (F02)** with idempotent debit/partial-credit/final-close/rollback handling and reconciliation. Acceptance evidence: injected timeouts and crashes before/after each external operation never duplicate, omit or invent financial effects. Exact protocol cases remain **NOT VERIFIED — REQUIRES SAYCOVE INTEGRATION SPEC**.
3. **Normalize persistent state and bound live sessions (F03/F07/F09).** Acceptance evidence: long histories and resource limits cannot prevent settlement of an accepted round; multiple workers serialize the same player/round; backup/recovery tests reconcile all ledger entries. Do not use the local file store for real money.
4. **Pin immutable math and settlement versions (F11)** before changing any multipliers, caps, wager limits or rounding. Acceptance evidence: a round begun before an upgrade settles under its original approved rules; all old proofs remain verifiable.
5. **Agree the actual RTP and maximum exposure (F04/F06).** Acceptance evidence: signed-off mode/wager/strategy mathematics, disclosed rounding and limits, and capacity to honor the worst accepted obligation. Repeat the optimal-strategy sweep for any revised model.
6. **Complete recovery and round closure (F05).** Acceptance evidence: session loss, device changes, final-stop disconnects and abandoned rounds resolve under disclosed and auditable rules without client-only authority.
7. **Strengthen proofs and receipts (F08/F10).** Acceptance evidence: altered algorithm/version/financial metadata is rejected, original commitments are retained where needed, semantically identical retries behave consistently, and reserved IDs cannot cause false conflicts.
8. **Validate the actual deployment.** Compare deployed frontend/backend artifacts to the approved commit, run the concurrency/fault suite on the intended database/runtime, inspect secret access and gateway controls, and complete independent testing required by the selected market/operator. Authenticated live and infrastructure claims remain **NOT VERIFIED** until those checks occur.

### Reproduction and evidence record

The private repository is the canonical source. Standard checks run in the isolated copy were: npm test; npm run test:hosted; npm run test:collisions. No hosted build or release was required or claimed, and no deployment was made. The audit used temporary scripts outside the copied production source. They generated exact math, simulation counts, adversarial outcomes, browser response traces and additional proofs; no runtime wallet or unrevealed seed is included in the GitHub report.

To reproduce the numerical model directly from the pinned source: enumerate h-subsets of {1…20}; count those whose smallest position is greater than s; divide by C(20,h); apply the literal integer multipliers and half-up payout formula; maximize Sₛg(w,s) for every w=100…100,000; combine each three-part split for W=300…300,000. For an independent simulation, call production newSeed() once per sample and hazardDeck(seed,'saycove-audit-'+mode,nonce,A/B/C,h) three times with nonce=0…999,999 in each mode. For each s count cargoes with min(deck)>s; sum the actual fixed-target payouts. This reproduces the method, not the original random sample.

Local evidence files were retained in this audit workspace. SHA-256 identities below make the exact harnesses/results distinguishable from later reruns. Only this Markdown report is the requested deliverable and is to be saved in GitHub.

| Evidence | SHA-256 |
| --- | --- |
| audit-math.mjs | 841970c2b2b6108e875fae504baa363864ecdbbb49a1ee85658eb9ceacdc6386 |
| audit-sim.mjs | 635f982b83d6e910fb965db22186190760e9b1fe437fecf470ca656482ec472c |
| audit-exploits.mjs | be76254dcfe56bd472e3e561b79c564c07be194ff38e942817ffc203fd7eb5e9 |
| audit-extra.mjs | 4cd23cddd9098deb6fcec22327ec06837e660f5ba0c71c8637e82e8ef582bee1 |
| audit-findings.mjs | 4c4bcdbcf2c7b1dd8814ca0125c27627c7d4dd082687e498f7e4e58233630a3d |
| audit-results/mathematics.json | 31c4c78727a3c9295088143603058875cb5ae2f3ab0839c27fdf125e02c9e715 |
| audit-results/simulation.json | eeca44ed6adda7ab0a5d9d859d0162254420ee3f67b649f8323804168adb04d4 |
| audit-results/simulation-summary.json | 3257264479a30b31e534dca01ccdd235a037f0ac64f4dda9f17ddf8069380e59 |
| audit-results/exploits.json | 29dff4c099756d48fbfec76e0833a7c47b9e78252057c68c523d618955b388e0 |
| audit-results/extra.json | 6eef4d4f2b7172e091a6e9ab695e2f706fb4f8690017a0578ea9d96a29c15210 |
| audit-results/findings.json | b32f2bcdeffe6b7d7e411b60722b3bebc79a9ffc8c5963f824a0ab847ec55fc6 |


The numerical aggregates and reproduced findings in this document are self-contained; external references are the pinned private source links, Node's cryptographic API documentation, Cloudflare's documented storage limit, and Saycove's own website. No unverified third-party API was treated as Saycove's contract.

## 13. Final verdict

The game has a viable and analytically bounded core, with encouraging tested RNG, cent accounting and concurrency behavior. There is no demonstrated positive-expectation legitimate strategy or future-result leak in the audited paths. Nevertheless, the confirmed persistence/versioning defects and missing real-money transaction/recovery architecture prevent an integration-readiness sign-off today.

Scores assess the present implementation against a real-money pre-integration standard. They are audit judgments, not certification grades or probabilities of being secure.

| Category | Score / 10 | Reason |
| --- | --- | --- |
| Mathematics | 8 | Exact model, exhaustive wager/strategy analysis and sub-100% optimum; production RTP/exposure and versioning decisions remain. |
| RNG | 8 | Cryptographic source, HMAC separation, unbiased mapping and supporting samples; actual host/lab assurance not verified. |
| Financial safety | 5 | Exact cents and tested internal atomicity; external wallet, recovery and exposure safeguards absent. |
| Exploit resistance | 7 | Tested duplicate/race/manipulation paths held; versioning, resource, proof and deployment gaps remain. |
| Backend architecture | 4 | Useful shared engine and hosted CAS; monolithic growing sessions and missing production financial lifecycle are blockers. |
| Overall | 6 | Strong prototype foundation; substantial verified and unverified integration work remains. |


NOT READY FOR SAYCOVE
