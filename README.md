# ⛏️ PoW Inscription Miner: Robinhood Chain

Bitcoin-style Proof-of-Work mining for an inscription token on Robinhood Chain (EVM L2).
Users mine with their **CPU, GPU (WebGPU) or phone browser**. The **first** miner to solve the current block
claims **5,000 tokens** straight into their connected wallet (21M supply = 4,200 blocks). Difficulty adjusts every block to keep ~60s per block.
The same user can win any number of blocks.

Website mein 3 tabs hain: **Mine** · **Transfer** · **Marketplace** (on-chain order book, ETH mein buy/sell, live updates).

- 📐 Full explanation (Hinglish): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- 🚀 Production guide: [`docs/PRODUCTION.md`](docs/PRODUCTION.md)
- 💡 Feature ideas: [`docs/FEATURES.md`](docs/FEATURES.md)
- 🛒 Marketplace contract: [`contracts/contracts/TokenMarket.sol`](contracts/contracts/TokenMarket.sol)
- 📜 Contract: [`contracts/contracts/PowInscription.sol`](contracts/contracts/PowInscription.sol)
- 🌐 Web miner (phone + desktop): [`web/`](web)
- 🖥️ CLI miner: [`miner-cli/`](miner-cli)
- 🧠 Shared mining core + WebGPU Keccak kernel: [`shared/`](shared)

## 🚀 Kaise run karein (step by step)

### 0. Ek baar ka setup
- **Node.js 20+** install karo: https://nodejs.org (LTS version)
- **Git** install karo: https://git-scm.com
- Code download karo:
  ```bash
  git clone https://github.com/avmansari/project-new-.git
  cd project-new-
  git checkout claude/sweet-mccarthy-0adox4
  npm install
  ```
- Check karne ke liye: `npm test` (sab tests pass hone chahiye)

### 1. Local pe chalao (fake chain, free, sabse pehle yahi karo)
**3 alag terminal** kholo, sab mein `project-new-` folder ke andar:

| Terminal | Command | Kya hota hai |
|---|---|---|
| 1 | `npm run chain` | Local blockchain start (isko chalta rehne do) |
| 2 | `npm run deploy:local` | Contract deploy (easy difficulty). Address web + CLI mein apne aap save ho jata hai |
| 3 | `npm run web` | Miner website start → browser mein **http://localhost:5173** kholo |

Browser mein:
1. **"Connect wallet"** dabao (MetaMask). Website khud "Hardhat Local" network MetaMask mein add kar degi.
2. Terminal 2 mein chalao: `npm run fund -- <tera MetaMask address>` (gas ke liye 10 fake ETH)
3. **"Start mining"** dabao. Block solve hote hi "🎉 Block solved! Tu 5,000 XYZ claim kar sakta hai" aayega.
4. **"Claim tokens"** dabao → MetaMask mein **Confirm** → 5,000 XYZ seedha tere wallet mein.

> ⚠️ `npm run chain` band karke dobara chalaya toh chain reset ho jaati hai. Phir se `npm run deploy:local` karo aur browser refresh karo.

**CLI miner (optional, PC/server ke liye):** `miner-cli/.env` file banao:
```
PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
```
(yeh Hardhat ka public test account #1 hai, sirf local ke liye). Phir `npm run mine`.

### 2. Phone se mine karna (same WiFi, local test)
`npm run web` jo **Network** URL dikhata hai (jaise `http://192.168.x.x:5173`) usko phone ke browser mein kholo.
- Phone ko local chain bhi dikhni chahiye: chain `cd contracts && npx hardhat node --hostname 0.0.0.0` se chalao, aur `web/.env` file mein `VITE_RPC_URL=http://<PC-ka-IP>:8545` daalo.
- Plain `http://` pe phone ka GPU (WebGPU) nahi chalega, sirf CPU chalega. GPU ke liye site HTTPS pe deploy karo (step 3).

### 3. Robinhood Chain testnet pe deploy
> ⚡ **Shortcut: sab ek command mein.** `npm install` ke baad `npm run testnet` chalao. Yeh private key poochta hai (ya Enter dabao toh naya wallet banata hai), key `.env` mein save karta hai, faucet ETH aane ka wait karta hai, aur deploy kar deta hai.

👉 **Poori checklist: [`docs/TESTNET.md`](docs/TESTNET.md)**. Faucet: https://faucet.testnet.chain.robinhood.com

1. `contracts/.env.example` ko copy karke `contracts/.env` banao. Usme `PRIVATE_KEY` (testnet ETH waala wallet), `TOKEN_SYMBOL`, aur difficulty bharo.
2. `npm run deploy:testnet`. Isse contract deploy hota hai aur address web/CLI mein save ho jata hai.
3. Website host karo: repo ko Vercel pe import karo (`vercel.json` ready hai). HTTPS milega, phone pe GPU + wallet chalega.
4. Users site kholenge → Connect wallet → Start mining → Claim → approve.

> Chain ID `46630` / RPC `https://rpc.testnet.chain.robinhood.com/rpc` official Robinhood Chain docs se verify kar lena.

Project files: https://drive.google.com/drive/folders/1OLUHKGNSBcwCrs_PhZlf9YrtMuk2QPSU?usp=sharing
