# Hosted indexer (Ponder)

Server-side indexer for the token, marketplace and DEX pool. It stores every contract event in Postgres
and serves them over HTTP, so the website no longer has to scan the whole chain history in each visitor's browser.

## Run locally
```bash
cd indexer
npm install          # separate from the root workspaces (Ponder is a big dependency)
npm run dev          # http://localhost:42069  (uses the embedded PGlite database)
```
It reads the contract addresses + ABIs from `../web/src/deployment.json`, so deploy first (`npm run deploy:local` / `npm run testnet`).

Then start the website with it:
```bash
cd web && VITE_INDEXER_URL=http://localhost:42069 npx vite
```

## API
| Endpoint | What it returns |
|---|---|
| `GET /events?contract=token\|market\|pool&after=<block>` | events after `block` (max 5,000 per call, `more: true` if there are more) |
| `GET /graphql` | GraphQL explorer over the `event` table |
| `GET /health`, `/ready`, `/status` | built-in health checks |

## Deploy to production (Railway example)
1. Push the repo to GitHub.
2. Railway → New Project → Deploy from GitHub → pick the repo, **root directory `indexer`**.
3. Add a **Postgres** database to the project (Railway sets `DATABASE_URL`).
4. Variables:
   - `PONDER_RPC_URL` = a private Robinhood Chain RPC (Alchemy / QuickNode / Chainstack)
   - `DATABASE_SCHEMA` = e.g. `pow_v1` (change it when you redeploy the contracts)
   - `CORS_ORIGIN` = your website URL, e.g. `https://yourapp.vercel.app`
5. Start command: `npm start`. Health check path: `/ready`.
6. In Vercel (website) set `VITE_INDEXER_URL` = the Railway URL and redeploy.

Render, Fly.io or any VPS work the same way (Node 22+, `npm install && npm start`, Postgres via `DATABASE_URL`).
