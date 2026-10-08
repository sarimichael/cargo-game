# Local API

Base URL: `http://127.0.0.1:4173`. This API is for the included local play-money wallet. It is not an operator wallet protocol.

`GET /api/session` restores the browser's session, or creates one for a new visitor who has no session cookie. The cookie is `HttpOnly` and `SameSite=Strict`.

If the browser presents a well-formed session cookie whose session no longer exists, every API route returns **404 `SESSION_NOT_FOUND`**. No replacement wallet is created and the cookie is left unchanged. The browser explains this and offers an explicit choice. `POST /api/session` (same-origin, `Content-Type: application/json`, body `{}`) then starts a new demo session and sets a new cookie. If the browser still has a live session, it returns **409 `SESSION_EXISTS`** and changes nothing. All amounts are integer USD cents. The response contains `config`, `session`, the current/latest `round`, and the last 20 settled history summaries.

Every POST needs `Content-Type: application/json` with a UTF-8 body, the session cookie, a unique `actionId` (8–80 alphanumeric/hyphen characters), and the current session `revision`. Bodies containing invalid UTF-8 are refused with 400.

| Method and path | Additional request fields | Result |
|---|---|---|
| GET `/api/health` | None | Service status and play-money mode |
| GET `/api/session` | None | Wallet, seed commitment and current voyage (404 `SESSION_NOT_FOUND` for a missing saved session) |
| POST `/api/session` | None (`{}`) | Explicitly starts a new demo session when the browser has none or its saved one is missing; 409 `SESSION_EXISTS` otherwise |
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

On success, POST returns the new full session snapshot. Retry the **same body and actionId** after an uncertain network result. The action will not execute twice; the response contains `replayed: true` and the latest snapshot. Bodies are compared by content, so the order of JSON keys does not matter. Any action ID that matches the format is valid, including words such as `constructor`. Reusing an ID for a different body returns 409. Receipts stored before this comparison was introduced still replay.

Different action IDs with the same stale revision cannot both succeed. On `STALE_REVISION`, fetch the latest session and ask the player to make a fresh decision. Do not automatically repeat a stale bet, advance or collection with a new ID.

Public round fields include `id`, `difficulty`, `stakeCents`, `step`, `status`, `multiplier100`, `nextRisk`, `maxStops`, `returnedCents`, `netCents`, `containers`, `events` and `proof`. `status` is `active` or `settled`. Container status is `onboard`, `collected` or `lost`.

While active, `proof` contains the commitment hash, client seed and nonce. Only settled rounds reveal `serverSeed` and all three hazard decks.

Errors return `{ "error": "readable message", "code": "ERROR_CODE" }`. Invalid fields or invalid UTF-8 are 400; JSON nested more than 32 levels deep is 400 `JSON_TOO_DEEP`; no session cookie 401 (`SESSION_EXPIRED`); forbidden origin/host 403; missing routes/rounds 404; a missing saved session 404 (`SESSION_NOT_FOUND`); invalid state or revision 409; oversized request 413; wrong content type 415. Unexpected save errors are 500 and leave the in-memory state unchanged. If the local server has lost ownership of its save folder, every route that reads or writes saved state returns **503 `SERVER_UNAVAILABLE`** (no balance or voyage is included) and the server exits; restart it.

**Retrying `POST /api/session`.** The request is not idempotent, and the server does not detect a retry. The included browser applies a client-side safeguard only. If a start gets no answer (a network failure, a timeout or an unreadable response), the browser disables **Start a new demo session** and reads `GET /api/session` itself. If the new session's cookie arrived, that read loads it and nothing else is sent. A second start is allowed only after a read in that tab has completed and still reports the session missing. This does not make the request idempotent. A second start can still create an extra, unused session if the server committed the first start but its response (and cookie) never reached the browser, if two tabs start at the same time, or if the page is reloaded in between. Another client must not assume any duplicate protection. See CARGO_PHASE4A1_CORRECTION_REPORT.md (R5) for the server-side proposal, which still awaits approval, and CARGO_PHASE4A2_CORRECTION_REPORT.md (M3).

**Reading `GET /api/session` from a client.** Responses can arrive out of order. The included browser discards any session read that was sent before a later action, start or applied read. Within one session the `revision` only increases, so a lower revision from an in-order read means the cookie now names a different session; the browser re-reads once to confirm before showing it.

**Hosted only:** each session is stored as one database row with a 2,000,000-byte limit. When fewer than 64 KiB would remain, `POST /api/rounds` returns 409 with code `SESSION_STORAGE_FULL` and changes nothing. This guarantees that a voyage that was accepted can still be settled. Reads, collections on an active voyage, and replays keep working.

The local API deliberately refuses cross-origin POSTs and unrecognized Host headers. An operator launch must replace anonymous cookie sessions and establish its own authenticated, allowed embedding/origin rules.
