# Casino provider handover

## What this build delivers

A working browser game plus its authoritative server, exact payout ladder, local play-money wallet, round events, seed commitments/reveals, independent verifier, tests and source. The project can be reviewed and demonstrated without an external account or paid infrastructure.

## What must be implemented for an operator

This package includes no external casino credentials, operator wallet connector, real-money accounting, production deployment or certification. Those pieces depend on the chosen operator's protocol and delivery requirements.

1. **Authenticated launch.** Replace anonymous local sessions with the operator's verified launch/session token. Bind player, operator, currency, jurisdiction and permitted limits on the server. Use authenticated renewal and expiration rules.
2. **Operator wallet.** Replace the local balance with the operator's debit/credit/rollback protocol. Agree on bet, win and round identifiers; validate currency minor units; use durable idempotency keys. A local round update and an external wallet call cannot share this file store's transaction: implement a durable outbox/state machine with retries and reconciliation. Do not retry uncertain debits using new IDs.
3. **Durable production state.** Replace `Store` with a transactional database. Add locks or compare-and-swap per player/round, uniqueness constraints for ledger entries and actions, backups, retention and recovery. The supplied file store is for one local process: a folder lock (`server/lock.js`) refuses a second process and fences every write, but it does not provide fsync-level power-loss durability or multi-machine coordination.
4. **Limits and wallet exposure.** Agree on supported total stakes, currencies and maximum payouts. Expert's final multiplier is 181,060.88× per surviving container. The prototype intentionally applies the requested full ladder without a win cap; any production cap changes the math and must be visible and reviewed.
5. **Host and embedding configuration.** Deploy behind HTTPS, use secure cookies or authenticated API tokens, define allowed origins and embedding sites, and replace local Host restrictions and `frame-ancestors 'none'` with the agreed operator policy. Keep unrevealed seed material private.
6. **Testing and review.** Have the selected operator/testing laboratory review the complete game math, rounding, independent-container model, randomness, wallet handling and deployment against the requirements for the intended release. The browser verifier supplements review; it is not certification.
7. **Operational controls.** Add operator-required session limits, responsible-play integration, support tools, monitoring, timeouts, incident procedures and localization. Establish audit exports and wallet reconciliation before accepting money.

## Recommended handover materials

- This source ZIP and the playable local build.
- The 30-second Cargo video.
- `API.md`, `FAIRNESS.md` and the exact multiplier table in `public/math.js`.
- Test results and a sample verified round proof.
- The operator's integration specification once selected.

No provider endpoint or approval should be assumed. This source is a starting implementation to connect and review with a specific casino, rather than a ready-made certified supplier integration.
