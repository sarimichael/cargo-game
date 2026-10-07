# Working on Cargo

This repository is the canonical source for Cargo. Read README.md before editing. Follow the user's requested change and use the existing visual style and shared game engine.

## Preserve behavior

- Server outcomes are authoritative. Animation must not determine or change financial results.
- Retain integer-cent accounting, idempotent request receipts, session revision checks and seed commitment/reveal rules.
- Collected cargo stays secured after later losses.
- The iceberg appears only when all three container statuses are lost, including cumulative losses. Partial losses use debris. Collecting cargo does not trigger a collision.
- Keep desktop and phone layouts usable and honor reduced-motion preferences.

## Privacy

Keep the repository private and preserve the hosted site's existing private audience. Do not commit `data/`, `.env` files, credentials, database exports or unrevealed server seeds. The hosting manifest records project identity, not authorization. Inspect current hosting access before publishing; do not broaden it as a side effect of an edit.

## Verification

Run `npm test` for game or API changes. Run `npm run test:hosted` when modifying the hosted adapter, schema or shared engine. Run `npm run test:collisions` for collision behavior or visual result mapping. Run `npm ci` and `npm run build` for a hosted release. Verify changed UI in a real browser, including phone layout when relevant. Do not repeat unrelated checks after they pass unless a new change warrants it.

## GitHub changes

Inspect the current branch and files before editing. Save a clear commit describing the result. Respect changes made by the user or others. Do not force-push or replace unrelated history. When using the GitHub API, inspect the current branch head and use its SHA as the parent and expected ref value. Tell the user which commit or pull request contains the change.

## Updating the existing private website

Saving code to GitHub does not automatically deploy it. For a requested update to the live prototype, use the Sites building and hosting skills and inspect the project identified in `.openai/hosting.json`.

The existing Site has a separate source history. Open a fresh staging checkout from its current hosted source, then copy the relevant GitHub-tracked project files into that checkout. Preserve its `.git` directory and deployment configuration. Do not copy `.git`, `node_modules`, `dist`, wallets or credentials from another checkout. Build and verify the staged version, save it through the Sites source workflow, and publish while preserving the current private audience. Never force-push the GitHub history into the Site source repository. Verify the deployment and live behavior before reporting a website update.

Keep API contracts and handover documentation accurate when behavior changes. Report source changes separately from deployment status so the user knows whether the phone link is updated.
