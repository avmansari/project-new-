# Going to production

Order: **Local → Testnet → Audit → Mainnet**. Don't skip a step.

---

## Phase 1: Testnet (now)
Details: [`TESTNET.md`](TESTNET.md)

1. `npm run testnet` deploys the token and the marketplace.
2. Commit + push `web/src/deployment.json` and `miner-cli/deployment.json`.
3. Host on Vercel (see Phase 3) and share the link with friends/community.
4. Run the testnet for **at least 1-2 weeks**:
   - 10-20 people mining from different devices (phones, laptops, GPU PCs)
   - Everyone tries buy / sell / bid / cancel on the marketplace
   - Does the block time settle around ~2 min? How much gas does a claim cost?
   - Collect bugs and feedback in one place (GitHub Issues / a form)

## Phase 2: Before mainnet (mandatory)

| Task | Why | How |
|---|---|---|
| **Lock final parameters** | Contracts can't be changed after deploy | `PowInscription.sol` constants: `BLOCK_REWARD`, `TARGET_BLOCK_TIME`, `MAX_SUPPLY`; `.env`: difficulty bits, `FEE_RECIPIENT`, `MINT_FEE_USD` (0.1), `MARKET_FEE_BPS` (200 = 2%) |
| **Keep the $0.10 claim fee in sync** | ETH price moves; the fee is stored in ETH | Run `npm run set-fee` daily (e.g. a cron / GitHub Action), or set `PRICE_FEED` if the chain has a Chainlink ETH/USD feed |
| **Read the internal review** | Known findings are fixed and documented | [`docs/AUDIT.md`](AUDIT.md) |
| **Smart contract audit** | Real money will be at stake; one bug can drain everything | An audit firm (Cantina, Code4rena contest, Sherlock, Hacken), or on a smaller budget an experienced freelance auditor. At least 2 independent reviews |
| **Verify on the explorer** | Users can read the contract code → trust | Blockscout verification (hardhat-verify plugin) |
| **Fresh deployer wallet** | The testnet key has been shared | New wallet, ideally a hardware wallet (Ledger/Trezor) |
| **Fee wallet = multisig** | One leaked key = all fees stolen | Safe (safe.global) multisig, 2-of-3 signers. Use `setFee` / `transferOwnership` to hand the market to the multisig |
| **Legal check** | A token + marketplace may fall under regulations | Talk to a crypto lawyer in your country once (India: VDA tax / TDS rules) |
| **Terms + disclaimer** | "Not financial advice", "use at your own risk" | Already built (`/terms.html` + I-agree popup). Have a lawyer review the text and add your project name/contact |

## Phase 3: Website hosting (HTTPS)

**Vercel (free, recommended):**
1. Connect the GitHub repo to Vercel → New Project → select the repo.
2. Root directory = repo root. `vercel.json` is already there (build: `npm run build -w web`, output: `web/dist`).
3. Deploy. You get `https://<name>.vercel.app`.
4. Add your own domain (e.g. `xyzmine.com`) under Vercel → Settings → Domains.

**Environment variables (Vercel → Settings → Environment Variables):**
- `VITE_WC_PROJECT_ID`: WalletConnect project ID (free, https://cloud.reown.com), so phone wallets can connect via QR.
- `VITE_RPC_URL`: your private RPC (see below). The public RPC will rate-limit you as traffic grows.
- `VITE_INDEXER_URL`: URL of the hosted indexer (see Phase 5).
- `VITE_CONTRACT_ADDRESS` / `VITE_MARKET_ADDRESS` / `VITE_POOL_ADDRESS`: optional overrides; otherwise they come from `deployment.json`.

**Private RPC:** get a Robinhood Chain endpoint from Alchemy, QuickNode or Chainstack. Start on the free tier, upgrade as users grow.

## Phase 4: Mainnet launch
1. Fill `RH_MAINNET_RPC`, `RH_MAINNET_CHAIN_ID` (from the official docs) and a new `PRIVATE_KEY` in `contracts/.env`.
2. Add the mainnet chain in `web/src/config.js` (same shape as the testnet block, with the new chainId/RPC/explorer).
3. Run `npx hardhat run scripts/deploy.js --network robinhood` (inside `contracts/`).
4. *(Optional, later)* **DEX pool:** deploy with `DEPLOY_POOL=true`, set `VITE_ENABLE_DEX=true`, and add the first liquidity (ETH + lots) from the Marketplace tab to set the starting price.
5. Transfer ownership of **all three** contracts (token: claim fee; market + pool: trading fees) to the multisig, and set `FEE_RECIPIENT` to the wallet you want the revenue in.
6. Commit the mainnet `deployment.json` → Vercel redeploys automatically.
7. Announce the launch with an exact **start time** so everyone starts together (fair launch).

## Phase 5: After launch (monitoring)
- **Uptime:** UptimeRobot (free) pinging the website and RPC.
- **Errors:** add Sentry (free tier) to the web app to see users' browser errors.
- **Analytics:** create a site on plausible.io (or self-host) and set `VITE_PLAUSIBLE_DOMAIN` (and `VITE_PLAUSIBLE_SRC` if self-hosted) on Vercel. Visitors, wallet connects, mining starts, claims and trades then show up in Plausible; the owner dashboard links to it.
- **Indexer:** deploy the Ponder app in [`indexer/`](../indexer/README.md) (Railway / Render + Postgres) and set `VITE_INDEXER_URL` on Vercel. Without it every visitor scans the chain history in their browser, which gets slow as the history grows.
- **Community:** Telegram / Discord + X (Twitter) with a bot auto-posting block milestones.

---

## Checklist
- [ ] 1-2 weeks on testnet with 10+ users
- [ ] Parameters final
- [ ] Audit done + issues fixed
- [ ] Fresh mainnet wallet (hardware)
- [ ] Market owner = multisig
- [ ] Contracts verified on the explorer
- [ ] Private RPC + Vercel env vars
- [ ] Custom domain + HTTPS
- [ ] Terms/disclaimer page
- [ ] Sentry + uptime monitor
- [ ] Launch time announced
