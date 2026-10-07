# Local API

Base URL: `http://127.0.0.1:4173`. This API is for the included local play-money wallet. It is not an operator wallet protocol.

`GET /api/session` creates or restores an anonymous browser session. The cookie is `HttpOnly` and `SameSite=Strict`. All amounts are integer USD cents. The response contains `config`, `session`, the current/latest `round`, and the last 20 settled history summaries.

Every POST needs `Content-Type: application/json`, the session cookie, a unique `actionId` (8–80 alphanumeric/hyphen characters), and the current session `revision`.

| Method and path | Additional request fields | Result |
|---|---|---|
| GET `/api/health` | None | Service status and play-money mode |
| GET `/api/session` | None | Wallet, seed commitment and current voyage |
| POST `/api/rounds` | `difficulty`, `stakeCents`, `clientSeed`, `expectedSeedHash` | Deducts one bet; creates an active round at step 0 |
| POST `/api/rounds/{id}/advance` | None | Attempts exactly one more stop |
| POST `/api/rounds/{id}/collect` | `containerId`: `A`, `B`, `C` or `all` | Credits and secures selected remaining cargo |
| GET `/api/rounds/{id}` | None | Owned round state and proof; future hazards remain hidden while active |
| POST `/api/reset` | None | Sets play balance to $1,000; disallowed during an active round |

Example bet request:

```json
{
  "actionId": "c668e42c-7c98-45c5-9144-dc2d42aa233a",
  "revision": 0,
  "difficulty": "easy",
  "stakeCents": 3000,
  "clientSeed": "my-client-seed",
  "expectedSeedHash": "the nextSeedHash returned by GET /api/session"
}
```

On success, POST returns the new full session snapshot. Retry the **exact same body and actionId** after an uncertain network result. The action will not execute twice; the response contains `replayed: true` and the latest snapshot. Reusing an ID for a different body returns 409.

Different action IDs with the same stale revision cannot both succeed. On `STALE_REVISION`, fetch the latest session and ask the player to make a fresh decision. Do not automatically repeat a stale bet, advance or collection with a new ID.

Public round fields include `id`, `difficulty`, `stakeCents`, `step`, `status`, `multiplier100`, `nextRisk`, `maxStops`, `returnedCents`, `netCents`, `containers`, `events` and `proof`. `status` is `active` or `settled`. Container status is `onboard`, `collected` or `lost`.

While active, `proof` contains the commitment hash, client seed and nonce. Only settled rounds reveal `serverSeed` and all three hazard decks.

Errors return `{ "error": "readable message", "code": "ERROR_CODE" }`. Invalid fields are 400; expired session 401; forbidden origin/host 403; missing routes/rounds 404; invalid state or revision 409; oversized request 413; wrong content type 415. Unexpected save errors are 500 and leave the in-memory state unchanged.

The local API deliberately refuses cross-origin POSTs and unrecognized Host headers. An operator launch must replace anonymous cookie sessions and establish its own authenticated, allowed embedding/origin rules.
