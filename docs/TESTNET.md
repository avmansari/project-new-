# Robinhood Chain Testnet Launch Checklist

Testnet first → make sure everything works → then mainnet.

> ⚡ **Shortcut: one command.** After `npm install`, run `npm run testnet`. It asks for a private key (or press Enter to create a new wallet), saves it to `.env`, waits for faucet ETH, and deploys the token + marketplace.

## Network details
| | |
|---|---|
| Chain ID | `46630` |
| RPC | `https://rpc.testnet.chain.robinhood.com/rpc` |
| Explorer | https://explorer.testnet.chain.robinhood.com |
| Faucet | https://faucet.testnet.chain.robinhood.com (backup: https://faucet.quicknode.com/robinhood/testnet) |
| Gas token | ETH |

(Official source: https://docs.robinhood.com/chain/connecting. Double-check before deploying.)

## Step 1: Prepare a wallet (private key)

**Option A (easiest): create a new wallet with a command**
```bash
npm run new-wallet
```
This creates a new wallet, saves its key directly into `contracts/.env`, and prints the address. Get testnet ETH for that address from the faucet. Done.

**Option B: export a key from MetaMask**
1. Create a **separate new account** in MetaMask for testnet only. Never use an account with real funds.
2. ⋮ next to the account → **Account details** → **Show private key** → enter password → copy.
3. Paste it in `contracts/.env` as `PRIVATE_KEY=0x...` (it must start with `0x`; add it if missing).

Either way, get ETH from the faucet: https://faucet.testnet.chain.robinhood.com

> ⚠️ Never paste a private key into a chat, email or website. Anyone with the key controls the wallet.

## Step 2: Deploy
```bash
cd project-new-
npm install                                  # if you haven't already
copy contracts\.env.example contracts\.env   # Windows
# cp contracts/.env.example contracts/.env   # Mac/Linux
```
Open `contracts/.env` and fill it in (with Option A, `PRIVATE_KEY` is already set):
```
PRIVATE_KEY=0x<your testnet private key>
TOKEN_NAME=Robin PoW
TOKEN_SYMBOL=XYZ
MIN_DIFFICULTY_BITS=21
INITIAL_DIFFICULTY_BITS=27
FEE_RECIPIENT=0x<wallet that receives all fees; empty = deployer>
MINT_FEE_USD=0.1
MARKET_FEE_BPS=200
```
Then:
```bash
npm run deploy:testnet
```
Expected output:
```
Network : robinhoodTestnet (chainId 46630)
Deployer: 0x...  balance 0.5 ETH
Fees    : claim $0.1 = 0.0000303 ETH (ETH = $3300) → 0x...
PowInscription deployed at: 0xABC...
TokenMarket deployed at:    0xDEF... (1 lot = 5000.0 tokens, fee 2% → 0x...)
Explorer (token):  https://explorer.testnet.chain.robinhood.com/address/0xABC...
wrote ../web/src/deployment.json
wrote ../miner-cli/deployment.json
```
**Save the contract addresses.** `web/src/deployment.json` and `miner-cli/deployment.json` now point to testnet. Commit them so the hosted website uses the live contracts.

## Step 3: Test on your PC
```bash
npm run web          # http://localhost:5173
```
- **Connect wallet** (on the testnet, with a little testnet ETH).
- **Start mining** → block solved → **Claim tokens** → confirm in wallet → 5,000 tokens in your wallet; the tx shows on the explorer.
- **Transfer** tab: send some tokens to a second wallet.
- **Marketplace** tab: list a lot, buy it from a second wallet, place a bid, cancel.

CLI too: put `PRIVATE_KEY=...` in `miner-cli/.env`, then `npm run mine`.

## Step 4: Put the website online (HTTPS, for phone users)

**WalletConnect (for phone wallets, optional but recommended):** create a free account at https://cloud.reown.com → New project → copy the **Project ID**. Locally put `VITE_WC_PROJECT_ID=<id>` in `web/.env`; on Vercel add the same under Settings → Environment Variables.

**Vercel (free):**
1. Push the code to GitHub (including `deployment.json`).
2. vercel.com → New Project → pick this repo → Root directory = repo root (`vercel.json` is included) → Deploy.
3. Open the `https://...vercel.app` link on a phone and mine. Over HTTPS the phone GPU (WebGPU) works too.

## Step 5: What to verify on testnet (before mainnet)
- [ ] 2-3 people (phone + PC) mine at the same time. Only one wins each block; the others see "someone else claimed this block"
- [ ] Block time: difficulty adjusts after every block ("Required zero bits" on the site, `Retarget` events on the explorer) and settles around ~2 min per block
- [ ] Nobody mines for 20+ min → difficulty eases (stall rescue)
- [ ] Every claim puts exactly 5,000 tokens in the claiming wallet
- [ ] Marketplace: only whole lots can be listed/bought/sold, price per lot is correct, 2% fee arrives in the fee wallet
- [ ] Claim fee: each claim sends ~$0.10 of ETH to the fee wallet; `npm run set-fee` updates it
- [ ] Stats tab: leaderboard and charts fill in; Marketplace: price chart, 24h stats, quick buy; Transfer: your activity
- [ ] Order expiry (list with 24h, check it disappears after 24h, Reclaim) and Make offer → Accept
- [ ] Share card after a claim: Share on X / Download work on phone + desktop
- [ ] Owner dashboard `/admin.html` shows revenue; hosted indexer (`indexer/README.md`) running and `VITE_INDEXER_URL` set
- [ ] Note the gas cost per claim and per trade (how much ETH users need)
- [ ] Tokens show up in wallets ("Add token to wallet" button, or import the contract address)
- [ ] GPU names show correctly on different machines
- [ ] Finalise parameters: reward, block time, max supply, difficulty, fee (constants need a new deploy)

## Mainnet (later)
See [`PRODUCTION.md`](PRODUCTION.md). In short: **audit**, fresh hardware wallet, multisig owner, then deploy with `RH_MAINNET_RPC` / `RH_MAINNET_CHAIN_ID` (the `robinhood` network is already in `hardhat.config.js`).
