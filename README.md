# ⛏️ PoW Inscription Miner: Robinhood Chain

Bitcoin-style Proof-of-Work mining for an inscription token on Robinhood Chain (EVM L2).
Users mine with their **CPU, GPU (WebGPU) or phone browser**. The **first** miner to solve the current block
claims **5,000 tokens** straight into their connected wallet (21M supply = 4,200 blocks). Difficulty adjusts after every block to target ~2 minutes per block.
The same user can win any number of blocks.

The website has 3 tabs: **Mine** · **Transfer** · **Marketplace** (on-chain order book, whole lots only: 1 lot = 5,000 tokens, priced in ETH per lot, live updates). Wallets: MetaMask, Rabby, Coinbase, OKX, Trust… plus WalletConnect.

- 📐 Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- 🧪 Testnet launch checklist: [`docs/TESTNET.md`](docs/TESTNET.md)
- 🚀 Production guide: [`docs/PRODUCTION.md`](docs/PRODUCTION.md)
- 💡 Feature ideas / roadmap: [`docs/FEATURES.md`](docs/FEATURES.md)
- 📜 Token contract: [`contracts/contracts/PowInscription.sol`](contracts/contracts/PowInscription.sol)
- 🛒 Marketplace contract: [`contracts/contracts/TokenMarket.sol`](contracts/contracts/TokenMarket.sol)
- 🌐 Web app (phone + desktop): [`web/`](web)
- 🖥️ CLI miner: [`miner-cli/`](miner-cli)
- 🧠 Shared mining core + WebGPU Keccak kernel + GPU name detection: [`shared/`](shared)

## 🚀 Getting started

### 0. One-time setup
- Install **Node.js 20+** (LTS): https://nodejs.org
- Install **Git**: https://git-scm.com
- Get the code:
  ```bash
  git clone https://github.com/avmansari/project-new-.git
  cd project-new-
  git checkout claude/sweet-mccarthy-0adox4
  npm install
  ```
- Sanity check: `npm test` (all tests should pass)

### 1. Run locally (fake chain, free: start here)
Open **3 terminals**, all inside the `project-new-` folder:

| Terminal | Command | What it does |
|---|---|---|
| 1 | `npm run chain` | Starts a local blockchain (keep it running) |
| 2 | `npm run deploy:local` | Deploys the token + marketplace. Addresses are saved for the web app and CLI automatically |
| 3 | `npm run web` | Starts the website → open **http://localhost:5173** |

In the browser:
1. Click **"Connect wallet"** and pick your wallet from the list (MetaMask / Rabby / Coinbase…). The site adds the "Hardhat Local" network to your wallet.
2. In terminal 2 run `npm run fund -- <your wallet address>` (10 fake ETH for gas).
3. Click **"Start mining"**. When a block is solved you'll see "🎉 Block solved! You can claim 5,000 XYZ".
4. Click **"Claim tokens"** → **Confirm** in your wallet → 5,000 XYZ land in your wallet.

> ⚠️ Restarting `npm run chain` resets the chain. Run `npm run deploy:local` again and refresh the browser.

**CLI miner (optional, for PCs/servers):** create `miner-cli/.env`:
```
PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
```
(this is Hardhat's public test account #1, local use only). Then run `npm run mine`.

### 2. Mining from a phone (same Wi-Fi, local test)
Open the **Network** URL printed by `npm run web` (e.g. `http://192.168.x.x:5173`) in your phone's browser.
- The phone must also reach the local chain: start it with `cd contracts && npx hardhat node --hostname 0.0.0.0`, and put `VITE_RPC_URL=http://<your-PC-IP>:8545` in `web/.env`.
- Over plain `http://` the phone's GPU (WebGPU) is unavailable, so only the CPU mines. For GPU mining, host the site over HTTPS (step 3).

### 3. Deploy to Robinhood Chain testnet
> ⚡ **Shortcut: one command.** After `npm install`, run `npm run testnet`. It asks for a private key (or press Enter to create a new wallet), saves it to `.env`, waits for faucet ETH, and deploys everything.

👉 **Full checklist: [`docs/TESTNET.md`](docs/TESTNET.md)**. Faucet: https://faucet.testnet.chain.robinhood.com

1. Copy `contracts/.env.example` to `contracts/.env` and fill in `PRIVATE_KEY` (a wallet with testnet ETH), `TOKEN_SYMBOL` and the difficulty settings.
2. Run `npm run deploy:testnet`. This deploys the contracts and saves their addresses for the web app and CLI.
3. Host the website: import the repo on Vercel (`vercel.json` is ready). You get HTTPS, so GPU mining and wallets work on phones.
4. Users open the site → Connect wallet → Start mining → Claim → approve.

> Double-check chain ID `46630` and RPC `https://rpc.testnet.chain.robinhood.com/rpc` against the official Robinhood Chain docs.

## 🧪 Tests
```bash
npm test   # 18 Solidity tests (token + marketplace) + 18 JS tests (mining core, GPU names)
```

Project files: https://drive.google.com/drive/folders/1OLUHKGNSBcwCrs_PhZlf9YrtMuk2QPSU?usp=sharing
