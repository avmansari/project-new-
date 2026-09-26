# PoW Inscription on Robinhood Chain: Architecture (Hinglish)

## 1. Bitcoin mining kaise kaam karta hai (short)

Bitcoin mein har block ek **puzzle** hai:

```
SHA256(SHA256(block_header + nonce)) <= target
```

- `target` ek bada number hai. Target jitna **chhota**, puzzle utna **mushkil** (hash ke aage zyada zeros chahiye).
- Is equation ko ulta solve karne ka koi shortcut nahi hai. Miners bas `nonce = 0, 1, 2, …` try karte rehte hain. Isi guessing ko **Proof-of-Work** kehte hain.
- Jo miner **sabse pehle** valid nonce dhoondh ke network ko bhejta hai, wahi block jeet ta hai aur usko **block reward** milta hai.
- Har 2016 blocks ke baad **difficulty adjust** hoti hai taaki average block time ~10 min rahe. Hashpower badhe toh difficulty badhti hai, ghate toh ghat-ti hai.
- Har 210,000 blocks pe reward **half** ho jata hai (halving). Isse max supply 21M pe fixed rehti hai. (Apne project mein halving nahi hai: har block fixed 5,000 tokens, 4,200 blocks.)

Apan bilkul yahi model ek **smart contract** ke andar bana rahe hain, Robinhood Chain (EVM L2, Arbitrum Orbit) pe.

---

## 2. Apna design: ek nazar mein

```
┌──────────────────────────┐        getMiningInfo()         ┌──────────────────────────────┐
│  Miner (phone / PC)      │ ◀───────────────────────────── │  PowInscription.sol          │
│                          │   challenge, target, height    │  (Robinhood Chain)           │
│  CPU Web Workers  ─┐     │                                │                              │
│  WebGPU kernel    ─┼─▶ keccak256(challenge,addr,nonce)    │  • verify PoW                │
│  Node CLI threads ─┘     │   <= target ?                  │  • first solver wins block   │
│                          │                                │  • mint ERC-20 reward        │
│  "Block solved! Tu 5000  │   mint(nonce, challenge)       │  • emit Inscription JSON     │
│   XYZ claim kar sakta"   │ ─────────────────────────────▶ │  • new challenge + retarget  │
└──────────────────────────┘                                └──────────────────────────────┘
                                                                        │ events
                                                                        ▼
                                                     Explorer / indexer / "Recent blocks" UI
```

### Components

| Folder | Kya hai | Tech |
|---|---|---|
| `contracts/` | PoW + ERC-20 + inscription contract, tests, deploy script | Solidity 0.8.28, Hardhat |
| `shared/` | Mining core (hash input layout, batch miner, reward calc) + **WebGPU Keccak kernel** | Pure JS, WGSL |
| `web/` | Browser miner (phone + desktop). CPU workers + GPU, wallet connect, claim UI | Vite, viem |
| `miner-cli/` | Headless multi-thread miner for PCs/servers | Node.js, worker_threads, viem |

---

## 3. Puzzle (exact definition)

Contract ke andar:

```solidity
digest = keccak256(abi.encodePacked(challenge, msg.sender, nonce));
require(uint256(digest) <= currentTarget());
```

- **challenge** (`bytes32`): Bitcoin ke "previous block hash" jaisa hai. Har mined block ke baad naya banta hai:
  `keccak(oldChallenge, winningDigest, blockhash, height)`. Isliye koi pehle se future blocks mine nahi kar sakta.
- **msg.sender**: miner ka address hash ke andar hai. Iska matlab **koi tera solution chura nahi sakta**. Agar koi mempool se tera nonce copy kare toh uske address ke saath hash alag aayega aur fail hoga.
- **nonce** (`uint256`): miner jo guess kar raha hai.

Hash input exactly **84 bytes** ka hai. Isliye Keccak ka sirf **ek block** (136-byte rate) lagta hai, jo GPU pe fast chalta hai:

```
[ 0..31]  challenge
[32..51]  miner address
[52..75]  random prefix (har device/session alag → kabhi overlap nahi)
[76..79]  outer counter (thread id / GPU dispatch counter)
[80..83]  inner counter (hot loop / GPU thread id)
```

---

## 4. "First solver wins" + same user multiple times

- Contract mein ek time pe sirf **ek** `challenge` active hota hai.
- `mint()` call hone pe contract check karta hai ki `expectedChallenge == challenge`. Agar kisi aur ne pehle block mine kar liya toh challenge badal chuka hoga aur tx sasta revert hoga `StaleChallenge` ke saath.
- Pehla valid tx block jeet ta hai → `height++` → naya challenge → sab miners naye puzzle pe shift ho jaate hain (clients har ~2.5s poll karte hain).
- **Same user jitni baar chahe mine kar sakta hai**. Koi limit nahi. Har solved challenge = ek block = ek mint. `blocksMinedBy[address]` count rakhta hai.

---

## 5. Reward aur difficulty

UI yeh dikhata hai: *"Tune block #N mine kar liya. Difficulty: 26 zero bits required, tere hash mein 27. Tu claim kar sakta hai: **5,000 XYZ**"*, saath mein **Claim tokens** button.

- **Har block = fixed 5,000 tokens.** Max supply 21,000,000 hai, matlab total **4,200 blocks**.
- Reward difficulty se nahi badalta. Difficulty yeh decide karti hai ki block **kitna mushkil** hai aur **kitni der** mein aayega.
- Aakhri block mein jitna supply bacha hai utna hi milega. Uske baad mining band.

### Difficulty adjustment (har block pe)
- Target: **~60 sec mein ek block** (`TARGET_BLOCK_TIME`).
- Har block ke baad: `newTarget = oldTarget × (3T + laga_hua_time) / 4T`, jahan laga hua time max 5T tak count hota hai.
  - Block turant aaya → **25% mushkil** (har block pe). Isse zyada miners aaye toh difficulty jaldi upar jaati hai.
  - Block theek 60 sec mein aaya → difficulty same.
  - Block 5 min ya zyada mein aaya → **2× aasaan**.
- **Stall rescue:** agar 10 min (`STALL_PERIOD`) tak koi block nahi aaya, toh `currentTarget()` har 10 min pe 2× aasaan hota jaata hai. Isse chain kabhi atakti nahi.
- Deploy ke time set hota hai: `MIN_DIFFICULTY_BITS` (isse aasaan kabhi nahi hogi) aur `INITIAL_DIFFICULTY_BITS` (shuruaat). Testnet defaults: 20 / 26 bits.

| Difficulty | Hashes chahiye (avg) | 10-core PC (browser CPU, ~1-3M H/s) | Phone (~0.2-0.5M H/s) |
|---|---|---|---|
| 20 bits | 1M | < 1 sec | 2-5 sec |
| 26 bits | 67M | 20-60 sec | 2-5 min |
| 28 bits | 268M | 1.5-4 min | 9-20 min |

Jitne zyada miners, utni zyada difficulty. Upar wali table sirf ek miner ke liye hai.

---

## 6. Inscription

Har mint pe contract yeh event emit karta hai:

```
Inscribed(height, miner, 'data:,{"p":"prc-20","op":"mint","tick":"XYZ","blk":"42","amt":"5000"}')
```

- Format bilkul EVM inscriptions (ethscriptions / "xrc-20") jaisa `data:,{json}` hai, isliye indexers seedha padh sakte hain.
- **Saath mein asli ERC-20 balance bhi mint hota hai**, toh token wallets/DEX mein turant use ho sakta hai. Off-chain indexer pe depend nahi.
- Agar tujhe "pure calldata inscription" chahiye (jaise ethscriptions), toh ek indexer bana ke `Inscribed` events ko hi source-of-truth bana sakte hain. Structure already ready hai.

---

## 7. Miners: CPU, GPU, phone

### Browser (web/), phone + desktop dono
- **CPU:** `navigator.hardwareConcurrency - 1` Web Workers, har ek `@noble/hashes` keccak ke saath batch mining karta hai.
- **GPU:** WebGPU compute shader (`shared/keccak-wgsl.js`). WGSL mein 64-bit int nahi hote, isliye har Keccak lane `vec2<u32>` hai. Poora round unrolled hai. Har GPU thread ek nonce try karta hai; dispatch size auto-tune hota hai (~100ms) taaki phone hang na ho. GPU jo nonce bataye usko CPU pe re-verify kiya jaata hai.
  - Android Chrome, desktop Chrome/Edge: WebGPU chalta hai. iOS Safari (newer versions) mein bhi aa raha hai. Nahi mila toh automatically CPU pe fallback.
- **Screen wake lock** mining ke time phone ki screen on rakhta hai (background tab mein browsers mining slow kar dete hain).

### Wallet: same wallet se mine + claim
- User **Connect wallet** karta hai (MetaMask / Rabby / Coinbase / phone wallet app ka in-app browser).
- Mining usi wallet ke address ke saath hoti hai, kyunki address hash ke andar hai.
- Block solve hote hi **Claim tokens** button aata hai → wallet mein **approve** popup → tokens **seedha usi wallet mein**. Koi transfer ya dusra wallet nahi.
- Wallet mein account switch kiya toh mining naye account ke saath restart ho jaati hai.

### Solution milne ke baad flow
```
engine nonce dhoondhta hai
   → UI: "🎉 Block solved! Tu 5,000 XYZ claim kar sakta hai"  [Claim tokens]
   → user Claim dabata hai → wallet mein approve → tx confirm
   → 5,000 XYZ usi wallet mein → "My blocks" mein add → naya challenge → mining resume
   → agar beech mein kisi aur ne block claim kar liya → solution expire, mining next block pe
```

### CLI (miner-cli/)
Server/PC ke liye headless: `PRIVATE_KEY=0x.. THREADS=8 npm run mine`. Same logic, auto-submit.

---

## 8. Security / known trade-offs (aage dekhna hai)

| Topic | Abhi ka status | Aage kya kar sakte hain |
|---|---|---|
| Solution chori (front-running) | ✅ Safe: hash mein `msg.sender` hai | – |
| Sequencer ordering | Robinhood Chain (Arbitrum) FCFS sequencer hai, toh jiska tx pehle pahunche wahi jeet ta hai | – |
| Bots / GPU farms | Phone users ke against bade miners jeetenge (Bitcoin jaisa hi) | Per-address cooldown, ya "shares/pool" model jahan har valid share ko proportional reward mile |
| Stale tx gas loss | Loser ka tx `StaleChallenge` pe sasta revert hota hai | Private mempool / simulate before send |
| Keccak ASIC/GPU advantage | GPU ≫ phone CPU | Memory-hard hash (Argon2-type) off-chain verify karna mushkil hai. Trade-off hai |
| Claim approve karne mein time | Popup approve karne tak koi aur block le sakta hai | Jaldi approve karo; baad mein "auto-claim" option |
| Audit | ❌ Nahi hua | Mainnet se pehle audit zaroor |

---

## 9. Run karna (local, end-to-end)

```bash
npm install                      # root se, sab workspaces install
npm test                         # contract tests + shared tests

# terminal 1: local chain
cd contracts && npx hardhat node

# terminal 2: deploy (easy difficulty) → web/src & miner-cli mein deployment.json likh deta hai
npm run deploy:local

# terminal 3: web miner
npm run web                      # http://localhost:5173 → Connect wallet → Start mining → Claim
npm run fund -- <tera MetaMask address>   # local chain pe gas ke liye fake ETH

# terminal 4 (optional): CLI miner
cd miner-cli && PRIVATE_KEY=<hardhat account key> npm start
```

### Robinhood Chain testnet pe deploy
```bash
cp contracts/.env.example contracts/.env   # PRIVATE_KEY, TOKEN_SYMBOL, difficulty bits bharo
npm run deploy:testnet
npm run web                                # ya `npm run build -w web` karke Vercel/Netlify pe host karo
```
> Chain ID / RPC (`46630`, `https://rpc.testnet.chain.robinhood.com/rpc`) official docs se ek baar verify kar lena. `contracts/hardhat.config.js` aur `web/src/config.js` mein env se override ho sakte hain.
>
> Phone pe WebGPU + wallet ke liye site **HTTPS** pe honi chahiye (localhost ke alawa), isliye testing ke liye deploy kar dena.

---

## 10. Files map

```
contracts/contracts/PowInscription.sol   ← core logic (PoW verify, reward, retarget, inscription, ERC-20)
contracts/contracts/TokenMarket.sol       ← marketplace: sell listings + buy bids (ETH), partial fills, cancel, fee
contracts/test/TokenMarket.test.js       ← 6 marketplace tests
contracts/test/PowInscription.test.js    ← 11 tests (first-wins, anti-theft, 5000/block, retarget, stall…)
contracts/scripts/deploy.js              ← deploy + ABI/address export to web & cli
shared/pow-core.js                       ← input layout, batch miner, reward mirror
shared/keccak-wgsl.js                    ← WebGPU Keccak-256 kernel (tested == CPU output)
web/src/main.js                          ← app shell: wallet, balances, tabs
web/src/mine.js                          ← Mine tab (mining state machine + claim)
web/src/transfer.js                      ← Transfer tab
web/src/market.js                        ← Marketplace tab (order book, live polling)
shared/gpu-name.js                       ← GPU ka poora naam (WebGL renderer string → "NVIDIA GeForce RTX 3060 Ti")
web/src/engine.js                        ← CPU workers + GPU orchestration
web/src/gpu-miner.js                     ← WebGPU host code
web/src/cpu-worker.js                    ← CPU worker
web/src/chain.js                         ← viem: read info, wallets, submit mint
miner-cli/index.js, worker.js            ← headless miner
```

---

## 11. Marketplace (TokenMarket.sol)

On-chain **order book**, ETH mein trading:

- **Sell order (listing):** seller apne tokens contract mein lock karta hai (approve + list = 2 confirmations). Koi bhi poora ya thoda sa khareed sakta hai.
- **Buy order (bid):** buyer apna ETH lock karta hai. Jiske paas tokens hain woh usme bech sakta hai.
- **Cancel:** jo hissa bika nahi, woh wapas (tokens ya ETH).
- **Fee:** `MARKET_FEE_BPS` (default 1%, max 5%), ETH side se kat ke `FEE_RECIPIENT` ko jaati hai. Owner baad mein `setFee` se badal sakta hai.
- **Safety:** reentrancy guard, bid escrow exact track hota hai (rounding se kabhi zyada ETH nahi nikalta), extra ETH refund.
- **Realtime:** website har 4 sec pe orders + trades refresh karti hai (sirf jab Marketplace tab khula ho).
