# Cargo

A playable cargo voyage game for desktop and phones. Place a play-money bet across three containers, sail through increasingly risky stops, and collect each container independently.

This repository contains the latest game, including the iceberg collision when all three containers are lost and a softer timber collision for partial losses. GitHub is the source for future edits. The existing private prototype is hosted separately at [Cargo Voyage](https://cargo-voyage-phone-demo.sarimichael40.chatgpt.site/); saving code here does not automatically update that website.

## Run on your computer

Install [Node.js 24 or newer](https://nodejs.org/en/download). Node.js 24 is the supported version for the project's checks and hosted build (`package.json` engines). The local server itself refuses to start below Node.js 22. On Windows, double-click **START-CARGO.cmd**. Alternatively, run this command from the project folder:

```sh
npm start
```

Open **http://127.0.0.1:4173**. Keep the server running while you play. The local game uses Node's built-in modules and does not need a package installation. Opening `public/index.html` directly will not start the wallet or API.

The local server listens only on your computer. It creates `data/state.json` to save wallets, history, request receipts and unrevealed seeds. This directory is excluded from Git. `PORT` chooses a different port, and `CARGO_DATA_DIR` chooses a separate save directory.

## How to play

1. Choose a total bet and a difficulty: Easy, Medium, Hard or Expert.
2. Press **Set sail** to load three containers with an equal share of the bet.
3. Sail to the next stop. Higher stops increase the multiplier and the chance of losing each uncollected container.
4. Collect A, B or C independently, or collect all remaining cargo. Collected payouts stay secured.
5. A voyage ends when every container is collected or lost. At the final port, collect the remaining cargo.

Easy has 19 stops, Medium 17, Hard 15 and Expert 10. All 61 multipliers are included. The starting play balance is $1,000.00. The total bet ranges from $3.00 to $3,000.00, subject to the wallet balance. Amounts use integer cents; leftover split cents go to A, then B.

Each container follows an independent hazard deck. Risk shown in the interface is per uncollected container. If all three containers are eventually lost, the ship hits an iceberg; if a loss leaves any cargo onboard or collected, it hits smaller floating debris. These animations display the settled server result and do not change the odds or payouts. Reduced-motion preferences are respected.

## Fairness and reliability

The server controls outcomes, debits, payouts and progression. Each voyage uses a pre-bet server seed commitment, a client seed, a nonce and three deterministic hazard decks. Settled voyages reveal their seed and can be checked independently in the game's Fairness panel or with:

```sh
node tools/verify-round.mjs path/to/exported-round.json
```

Repeated actions cannot pay twice. Session revisions reject competing mutations. Refreshing restores an active voyage. Details are in [FAIRNESS.md](docs/FAIRNESS.md) and [API.md](docs/API.md).

## Development and checks

```sh
npm test
npm run test:hosted
npm run test:collisions
```

The local API tests cover accounting, invalid actions, retries, races, persisted sessions and independent proof verification. Hosted checks exercise the Worker with a local SQLite-backed database. Collision checks cover partial, simultaneous and cumulative losses, secured cargo and reduced motion.

To install the pinned build tools and build the hosted version:

```sh
npm ci
npm run build
```

The build produces `dist/client/` and `dist/server/`. Hosted dependencies are not needed to run the local game. See [AGENTS.md](AGENTS.md) for the editing and publishing workflow.

## Source map

| Path | Purpose |
| --- | --- |
| `public/` | Responsive interface, ship animation, obstacle artwork, shared math and browser proof checker |
| `public/collision.js` | Pure classification and timing for visual collisions |
| `server/game.js` | Shared authoritative game engine and accounting |
| `server/fairness.js` | Seed commitments and deterministic hazard decks |
| `server/app.js`, `server/index.js`, `server/store.js` | Local HTTP API and saved wallets |
| `server/worker.js` | Hosted API adapter with D1 transactions and sessions |
| `db/`, `drizzle/` | Hosted database schema and migrations |
| `build/` | Hosted build and verification tools |
| `test/`, `tools/`, `docs/` | Tests, independent verifier and handover documentation |
| `.openai/hosting.json` | Existing Sites project identity and bindings; contains no credential |

## Project status

This is a play-money prototype. Operator wallet integration, authenticated casino launches and production certification remain separate work; see [INTEGRATION.md](docs/INTEGRATION.md). The payout ladder was checked on 6 October 2026 against [Stake's official Chicken chart](https://stake.com/blog/how-to-play-chicken-on-stake). Cargo's artwork and implementation belong to this project; the game is not affiliated with Stake and uses its own randomness implementation.

Keep this repository private. Do not commit runtime wallets, access tokens, database exports or unrevealed server seeds.
