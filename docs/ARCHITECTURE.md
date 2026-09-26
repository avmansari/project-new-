# PoW Inscription on Robinhood Chain: Architecture

## 1. How Bitcoin mining works (short version)

In Bitcoin every block is a **puzzle**:

```
SHA256(SHA256(block_header + nonce)) <= target
```

- `target` is a big number. The **smaller** the target, the **harder** the puzzle (the hash needs more leading zeros).
- There is no shortcut to solve this backwards. Miners just try `nonce = 0, 1, 2, …` over and over. That guessing is called **Proof-of-Work**.
- The first miner to find a valid nonce and broadcast it wins the block and receives the **block reward**.
- Every 2,016 blocks the **difficulty adjusts** so that blocks keep coming every ~10 minutes: more hashpower → harder, less hashpower → easier.
- Every 210,000 blocks the reward **halves**, which caps the supply at 21M. (This project has no halving: every block is a fixed 5,000 tokens, 4,200 blocks in total.)

This project builds the same model inside a **smart contract** on Robinhood Chain (EVM L2, Arbitrum Orbit).

---

## 2. Design at a glance

```
┌──────────────────────────┐        getMiningInfo()         ┌──────────────────────────────┐
│  Miner (phone / PC)      │ ◀───────────────────────────── │  PowInscription.sol          │
│                          │   challenge, target, height    │  (Robinhood Chain)           │
│  CPU Web Workers  ─┐     │                                │                              │
│  WebGPU kernel    ─┼─▶ keccak256(challenge,addr,nonce)    │  • verify PoW                │
│  Node CLI threads ─┘     │   <= target ?                  │  • first solver wins block   │
│                          │                                │  • mint ERC-20 reward        │
│  "Block solved! You can  │   mint(nonce, challenge)       │  • emit inscription JSON     │
│   claim 5,000 XYZ"       │ ─────────────────────────────▶ │  • new challenge + retarget  │
└──────────────────────────┘                                └──────────────────────────────┘
            │                                                           │ events
            │  list / buy / bid / sell / cancel                         ▼
            └──────────────────────────▶ TokenMarket.sol      Explorer / "Recent blocks" UI
```

### Components

| Folder | What it is | Tech |
|---|---|---|
| `contracts/` | Token (PoW + ERC-20 + inscription), marketplace, tests, deploy scripts | Solidity 0.8.28, Hardhat |
| `shared/` | Mining core (hash input layout, batch miner), **WebGPU Keccak kernel**, GPU name detection | Plain JS, WGSL |
| `web/` | Web app for phone + desktop: Mine / Transfer / Marketplace tabs, multi-wallet connect | Vite, viem, WalletConnect |
| `miner-cli/` | Headless multi-threaded miner for PCs/servers | Node.js, worker_threads, viem |

---

## 3. The puzzle (exact definition)

Inside the contract:

```solidity
digest = keccak256(abi.encodePacked(challenge, msg.sender, nonce));
require(uint256(digest) <= currentTarget());
```

- **challenge** (`bytes32`): plays the role of Bitcoin's "previous block hash". A new one is derived after every mined block:
  `keccak(oldChallenge, winningDigest, blockhash, height)`, so nobody can pre-mine future blocks.
- **msg.sender**: the miner's address is part of the hash, so **nobody can steal a solution**. If someone copies your nonce from the mempool, the hash with their address is different and fails.
- **nonce** (`uint256`): what the miner is guessing.

The hash input is exactly **84 bytes**, so Keccak needs only **one block** (136-byte rate), which is fast on GPUs:

```
[ 0..31]  challenge
[32..51]  miner address
[52..75]  random prefix (different per device/session → never overlaps)
[76..79]  outer counter (thread id / GPU dispatch counter)
[80..83]  inner counter (hot loop / GPU thread id)
```

---

## 4. "First solver wins", and the same user can win many times

- The contract has exactly **one** active `challenge` at a time.
- `mint()` checks `expectedChallenge == challenge`. If someone else already mined the block, the challenge has changed and the tx reverts cheaply with `StaleChallenge`.
- The first valid tx wins → `height++` → new challenge → all miners switch to the new puzzle (clients poll every ~2.5 s).
- **A user can mine as many times as they like.** No limit: every solved challenge = one block = one mint. `blocksMinedBy[address]` keeps count.

---

## 5. Reward and difficulty

The UI shows: *"You mined block #N. Difficulty: 27 zero bits required, your hash has 28. You can claim: **5,000 XYZ**"*, with a **Claim tokens** button.

- **Every block = a fixed 5,000 tokens.** Max supply is 21,000,000, i.e. **4,200 blocks** in total.
- The reward does not depend on difficulty. Difficulty decides **how hard** a block is and **how long** it takes.
- The last block pays whatever supply is left; after that, mining stops.

### Difficulty adjustment (every block)
- Target: **~1 block every 2 minutes** (`TARGET_BLOCK_TIME = 120`). 4,200 blocks × 2 min ≈ **6 days** for the full supply.
- After every block: `newTarget = oldTarget × (3T + elapsed) / 4T`, with `elapsed` capped at 5T.
  - Block came instantly → **25% harder** (per block), so difficulty climbs quickly when more miners join.
  - Block took exactly 2 min → no change.
  - Block took 10 min or more → **2× easier**.
- **Stall rescue:** if no block is mined for 20 min (`STALL_PERIOD`), `currentTarget()` gets 2× easier every 20 min, so the chain never gets stuck.
- Set at deploy: `MIN_DIFFICULTY_BITS` (difficulty never goes below this) and `INITIAL_DIFFICULTY_BITS` (starting point). Testnet defaults: 21 / 27 bits.

| Difficulty | Hashes needed (avg) | 10-core PC (browser CPU, ~1-3M H/s) | Phone (~0.2-0.5M H/s) |
|---|---|---|---|
| 21 bits | 2M | ~1 s | 4-10 s |
| 27 bits | 134M | 45-130 s | 4-11 min |
| 28 bits | 268M | 1.5-4 min | 9-20 min |

The table is for a single miner. More miners → higher difficulty.

---

## 6. Inscription

On every mint the contract emits:

```
Inscribed(height, miner, 'data:,{"p":"prc-20","op":"mint","tick":"XYZ","blk":"42","amt":"5000"}')
```

- Same `data:,{json}` format as EVM inscriptions (ethscriptions / "xrc-20"), so indexers can read it directly.
- **A real ERC-20 balance is minted at the same time**, so the token works in wallets/DEXes immediately without depending on an off-chain indexer.
- If you ever want "pure calldata inscriptions" (like ethscriptions), an indexer can use the `Inscribed` events as the source of truth. The structure is already there.

---

## 7. Miners: CPU, GPU, phone

### Browser (`web/`), phone + desktop
- **CPU:** `navigator.hardwareConcurrency - 1` Web Workers, each batch-mining with `@noble/hashes` keccak.
- **GPU:** WebGPU compute shader (`shared/keccak-wgsl.js`). WGSL has no 64-bit ints, so each Keccak lane is a `vec2<u32>`; the round is fully unrolled. Each GPU thread tries one nonce; dispatch size auto-tunes to ~100 ms so phones don't freeze. Any nonce the GPU reports is re-verified on the CPU.
  - Works in Android Chrome and desktop Chrome/Edge; arriving in newer iOS Safari. Falls back to CPU automatically when missing.
- **Screen wake lock** keeps the phone screen on while mining (browsers throttle background tabs).

### Same wallet mines and claims
- The user clicks **Connect wallet** and picks a wallet.
- Mining uses that wallet's address, because the address is part of the hash.
- When a block is solved a **Claim tokens** button appears → wallet **approval** popup → tokens go **straight into that wallet**. No transfers, no second wallet.
- Switching accounts in the wallet restarts mining for the new account.

### Flow after a solution is found
```
engine finds a nonce
   → UI: "🎉 Block solved! You can claim 5,000 XYZ"  [Claim tokens]
   → user clicks Claim → approves in wallet → tx confirms
   → 5,000 XYZ in the wallet → added to "My blocks" → new challenge → mining resumes
   → if someone else claims the block first → solution expires, mining moves to the next block
```

### CLI (`miner-cli/`)
Headless for servers/PCs: `PRIVATE_KEY=0x.. THREADS=8 npm run mine`. Same logic, submits automatically.

---

## 8. Marketplace (`TokenMarket.sol`)

On-chain **order book** traded in ETH, **whole lots only**:

- **1 lot = 5,000 tokens** (one mined block). No smaller chunks.
- **Price = ETH per lot.** Every trade costs exactly `lots × pricePerLot`, no rounding.
- **Sell order (listing):** the seller locks N lots (approve + list = 2 confirmations). Anyone can buy 1…N whole lots.
- **Buy order (bid):** the buyer locks `lots × price` ETH. Any holder can sell whole lots into it.
- **Order expiry:** every listing/bid can expire after 24h / 7d / 30d (or never). Expired orders can't be filled; the maker clicks **Reclaim**, and **anyone** can call `reclaimExpired` to send the funds back to the maker (auto-cancel by keepers/bots).
- **Make offer:** a buyer can offer their own price for N lots of a specific listing (ETH escrowed, optional expiry). The seller sees it under "Offers on my listings" and can **Accept**; the buyer can cancel any time; expired offers can be reclaimed by anyone.
- **Quick buy (`buyMany`):** fills the cheapest listings for the requested number of lots in **one transaction** (all-or-nothing).
- **Fee:** `MARKET_FEE_BPS` (default **2%**, max 5%) of the ETH side, sent to `FEE_RECIPIENT` (also on accepted offers).
- **Safety:** reentrancy guard, payment checked before any transfer, overpayment refunds.

## 8a. DEX pool (`TokenPool.sol`): switched OFF for now

> Not deployed and hidden in the UI by default. To enable later: `DEPLOY_POOL=true` in `contracts/.env` when deploying, and `VITE_ENABLE_DEX=true` for the website. Someone (usually the project) must add the first liquidity.


Uniswap-V2-style constant-product pool (`x × y = k`) for TOKEN ↔ ETH, for **instant** trades without waiting for an order:
- **Whole lots only:** `buyLots(n)` pays ETH for exactly n lots, `sellLots(n)` sells exactly n lots. 1% slippage protection in the UI.
- **Fees (ETH):** 0.3% stays in the pool for liquidity providers + **protocol fee** `DEX_PROTOCOL_FEE_BPS` (default **2%**, max 5%) to `FEE_RECIPIENT`.
- **Liquidity:** anyone can add ETH + tokens at the current ratio and get LP tokens (`POW-LP`); remove any time. The **first provider sets the starting price** ("open the pool after launch"). 1,000 wei of LP is locked forever (standard V2 protection).
- Reserves are tracked internally, so donations can't move the price.

## 8b. Fees (project revenue)

Both fees go to the same wallet: `FEE_RECIPIENT` in `contracts/.env` (empty = the deployer wallet).

| Fee | Amount | Paid by | When |
|---|---|---|---|
| **Claim fee** | **$0.10 per lot** (in ETH) | the miner | on every successful claim (1 claim = 1 lot = 5,000 tokens). A losing (stale) claim reverts, so it pays nothing |
| **Marketplace fee** | **2%** of trade volume (in ETH) | taken from the ETH side of every trade | on every buy / sell / quick buy / accepted offer |
| **DEX fee** | **2%** protocol fee (in ETH) + 0.3% to LPs | taken from the ETH side of every swap | on every instant buy / sell |

How the $0.10 is turned into ETH (the contract can't read USD by itself):
- **Fixed mode (default):** at deploy, `MINT_FEE_USD` (0.1) is converted with the live ETH price into `mintFeeWei`. Run **`npm run set-fee`** from time to time (e.g. daily) to re-sync it with the ETH price. Only the owner can change it; it is capped at 0.01 ETH.
- **USD mode (optional):** if the chain has a Chainlink-style ETH/USD feed, set `PRICE_FEED` in `.env` (or call `setUsdFee`). The fee is then always exactly $0.10, and falls back to the fixed fee if the feed is older than 1 day. Capped at $1.

Owner functions (hand them to a multisig for mainnet): `setMintFeeWei`, `setUsdFee`, `setFeeRecipient`, `transferOwnership` on the token; `setFee`, `transferOwnership` on the market and the pool.

**Owner dashboard (`/admin.html`):** connect the owner or fee wallet to see revenue per source (claims / marketplace / DEX) for 24h / 7d / 30d / all time, revenue per day, users (miners, traders, holders), order-book + DEX volume, and to update fees (claim fee → $0.10 at today's ETH price, marketplace %, DEX %, fee wallet for all 3 contracts). The numbers are public on-chain data; the page only hides them from other visitors, and settings only work for the owner.

## 8c. Indexer, stats and charts

Two interchangeable data sources feed the same UI (`web/src/indexer.js`):
- **Hosted indexer (production):** the Ponder app in `/indexer` stores every event in Postgres and serves `GET /events?contract=…&after=<block>`. Set `VITE_INDEXER_URL` and the site fetches everything from one fast API. See [`indexer/README.md`](../indexer/README.md).
- **In-browser indexer (fallback / launch):** without `VITE_INDEXER_URL`, the site loads events from the RPC in adaptive chunks and caches them in `localStorage`.

It powers:
- **Stats tab:** network tiles, **leaderboard** (24h / 7d / all time) and **hashrate / block time / difficulty charts**.
- **Marketplace:** **price-per-lot candlestick chart** (order book + DEX trades), **24h volume / change / high / low**, **holders count**, recent trades.
- **Transfer tab → Your activity**, and the **owner dashboard**.

Charts are dependency-free SVG (`web/src/charts.js`) with crosshair/tooltips, keyboard focus and a data-table view. Up/down candles use a colour-blind-safe blue/red pair.

Mine-tab extras: **auto-claim**, **sound** and **browser notification** toggles, and a **share card**: after each claim a 1200×630 image ("I mined block #123 with RTX 3060 Ti ⛏️") with **Share on X** (opens the post + saves the image to attach), **Share…** on phones (sends the image straight to the X app) and **Download**.

## 9. Wallets

- **Browser extension wallets** are discovered automatically (EIP-6963): MetaMask, Rabby, Coinbase, OKX, Trust, Phantom, Brave, Zerion… each shown with its own name and icon.
- Older wallets that only expose `window.ethereum` still work.
- **WalletConnect:** when `VITE_WC_PROJECT_ID` is set, a "WalletConnect" option appears, so any mobile wallet app can connect by scanning a QR code.
- **Phones without an in-app wallet browser:** "Open in MetaMask / Trust / Coinbase" deep links.
- The last wallet is remembered and reconnects silently on reload. Clicking the address button disconnects.

## 10. GPU name detection (`shared/gpu-name.js`)

1. Exact model from the WebGL renderer string (e.g. "Intel Arc B580 Graphics", "NVIDIA GeForce RTX 3060 Ti").
2. If the driver reports a generic name ("Intel(R) Graphics"), the PCI device ID is used (Intel Arc A/B series).
3. If the browser hides the name, or WebGL and WebGPU run on different GPUs (dual-GPU laptops), the family of the WebGPU adapter (the one that actually mines) is shown: "Intel Arc B-series (Battlemage)", "NVIDIA GeForce RTX 30 series (Ampere)"…
4. If it's still wrong, the user can click **change** and set the name manually. "GPU details" shows the raw strings for debugging.

---

## 11. Security / known trade-offs

| Topic | Current status | Possible improvement |
|---|---|---|
| Solution theft (front-running) | ✅ Safe: `msg.sender` is inside the hash | – |
| Sequencer ordering | Robinhood Chain (Arbitrum) uses a first-come-first-served sequencer: the first tx to arrive wins | – |
| Bots / GPU farms | Big miners will beat phones (same as Bitcoin) | Per-address cooldown, or a "shares/pool" model paying proportionally to work |
| Gas lost on stale tx | The loser's tx reverts cheaply with `StaleChallenge` | Simulate before sending |
| Keccak GPU advantage | GPU ≫ phone CPU | Memory-hard hashes (Argon2-style) are hard to verify on-chain: a trade-off |
| Time to approve a claim | Someone else can take the block while the popup is open | Approve quickly; later an "auto-claim" option |
| Marketplace funds | ETH and tokens are escrowed in the contract | Audit before mainnet; fee owner = multisig |
| Audit | ❌ Not done yet | Mandatory before mainnet |

---

## 12. Running it (local, end-to-end)

```bash
npm install                      # from the repo root, installs all workspaces
npm test                         # contract tests + shared tests

npm run chain                    # terminal 1: local chain
npm run deploy:local             # terminal 2: deploy (easy difficulty) → writes deployment.json for web + CLI
npm run web                      # terminal 3: http://localhost:5173 → Connect wallet → Start mining → Claim
npm run fund -- <your address>   # fake ETH for gas on the local chain

cd miner-cli && PRIVATE_KEY=<hardhat account key> npm start   # optional CLI miner
```

### Robinhood Chain testnet
```bash
npm run testnet                  # asks for a key, waits for faucet ETH, deploys token + marketplace
npm run web                      # or host it on Vercel (vercel.json is included)
```
> Verify chain ID / RPC (`46630`, `https://rpc.testnet.chain.robinhood.com/rpc`) against the official docs. They can be overridden via env in `contracts/hardhat.config.js` and `web/src/config.js`.
>
> Phones need **HTTPS** (except localhost) for WebGPU and wallets, so deploy the site for real phone testing.

---

## 13. File map

```
contracts/contracts/PowInscription.sol   ← token: PoW verify, 5,000/block, per-block retarget, inscription, ERC-20
contracts/contracts/TokenMarket.sol      ← marketplace: whole-lot listings + ETH bids, expiry, offers, quick buy, fee
contracts/contracts/TokenPool.sol        ← DEX pool (x*y=k), whole-lot swaps, LP token, protocol fee
contracts/test/TokenPool.test.js         ← 6 tests (pricing, fees, slippage, liquidity)
contracts/test/PowInscription.test.js    ← 15 tests (first-wins, anti-theft, 5,000/block, retarget, stall, claim fee…)
contracts/test/TokenMarket.test.js       ← 16 tests (lots only, 2% fee, quick buy, expiry, offers, escrow, cancel…)
contracts/scripts/deploy.js              ← deploys token + market, exports ABIs/addresses to web & CLI
contracts/scripts/setup-testnet.js       ← `npm run testnet`: key → faucet wait → deploy
contracts/scripts/new-wallet.js          ← `npm run new-wallet`: fresh deployer key into .env
contracts/scripts/fund.js                ← `npm run fund`: local fake ETH
shared/pow-core.js                       ← hash input layout, batch miner
shared/keccak-wgsl.js                    ← WebGPU Keccak-256 kernel (verified == CPU output)
shared/gpu-name.js                       ← GPU name detection
web/src/main.js                          ← app shell: wallet, balances, tabs
web/src/wallets.js                       ← wallet picker (EIP-6963, WalletConnect, deep links)
web/src/mine.js                          ← Mine tab (mining state machine + claim + device info)
web/src/transfer.js                      ← Transfer tab + your activity
web/src/market.js                        ← Marketplace tab (order book, live polling)
web/src/engine.js                        ← CPU workers + GPU orchestration
web/src/gpu-miner.js                     ← WebGPU host code
web/src/cpu-worker.js                    ← CPU worker
web/src/chain.js                         ← viem: reads, claim (+fee), transfer, marketplace txs, quick buy
web/src/indexer.js                       ← in-browser event indexer (cached, incremental)
web/src/stats.js                         ← Stats tab: tiles, leaderboard, charts
web/src/swap.js                          ← DEX swap + liquidity UI
web/src/share.js                         ← share card image + Share on X
web/src/admin.js, web/admin.html         ← owner dashboard (revenue, alerts, settings)
web/index.html, src/landing.*            ← landing page + FAQ
web/app.html                             ← the app
web/terms.html, src/terms-gate.js        ← terms page + I-agree gate
web/src/leaderboard.js                   ← top 100 holders
web/src/analytics.js                     ← Plausible events
contracts/test/Security.test.js          ← regressions for the security review (docs/AUDIT.md)
indexer/                                 ← hosted Ponder indexer (events API + GraphQL)
web/src/charts.js                        ← SVG line + candlestick charts
web/src/price.js                         ← ETH/USD price for USD estimates
contracts/scripts/set-fee.js             ← `npm run set-fee`: keep the claim fee at ~$0.10
contracts/scripts/eth-price.js           ← ETH/USD helper for fee scripts
miner-cli/index.js, worker.js            ← headless miner
```

---

## 14. Pages, onboarding and admin extras

- **Landing page (`/`):** hero, live network numbers, how it works, tokenomics, fees up front, FAQ, "Launch app".
- **Terms gate (`/app.html`):** on the first visit a short risk summary appears; the user must tick "I have read and agree" and click **I agree** to continue. Acceptance is stored per browser; bump `TERMS_VERSION` in `web/src/terms-gate.js` when `terms.html` changes to ask again. `terms.html` is a template: have it checked by a lawyer.
- **Marketplace in US dollars:** all prices, totals, stats and the chart are shown in $, and users enter prices in $. On-chain prices stay in ETH: the $ price is converted with the live ETH/USD rate (Coinbase, then CoinGecko) when the order is created, and the wallet shows the exact ETH before signing. If the rate can't be loaded, the UI falls back to ETH.
- **Benchmark (Mine tab):** 10-second test with the selected CPU threads / GPU → hashrate, expected time per block at today's difficulty, and share of the network.
- **Leaderboard tab:** top 100 holders (wallet balance + lots they have listed), with your rank.
- **Owner dashboard alerts:** big trades (threshold in $), fee income (claims / marketplace / DEX), claims and offers; filter, sort by newest or largest, optional browser notifications while the dashboard is open. A warning box appears if any fees could not be delivered to the fee wallet (see AUDIT H-1) with a button to deliver them.
- **Analytics:** Plausible (privacy-friendly, no cookies) when `VITE_PLAUSIBLE_DOMAIN` is set. Custom events: Wallet connected, Mining started, Block claimed, Order created, Trade, Offer made, Benchmark run. The owner dashboard links to the Plausible dashboard.
