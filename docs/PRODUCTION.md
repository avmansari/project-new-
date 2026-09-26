# Production mein kaise le jaayein (Hinglish guide)

Order: **Local → Testnet → Audit → Mainnet**. Beech ka koi step skip mat karna.

---

## Phase 1: Testnet (abhi)
Details: [`TESTNET.md`](TESTNET.md)

1. `npm run testnet`. Isse token + marketplace dono deploy hote hain.
2. `web/src/deployment.json` aur `miner-cli/deployment.json` commit + push karo.
3. Vercel pe host karo (neeche Phase 3 dekho), aur link doston/community ko do.
4. **Kam se kam 1-2 hafte** testnet chalao:
   - 10-20 log alag devices (phone, laptop, GPU PC) se mine karein
   - Marketplace mein buy/sell/bid/cancel sab try karein
   - Block time ~2 min pe settle ho raha hai? Gas kitna lag raha hai per claim?
   - Bugs aur feedback ek jagah note karo (GitHub Issues / Google Form)

## Phase 2: Mainnet se pehle (zaroori)

| Kaam | Kyun | Kaise |
|---|---|---|
| **Final parameters lock karo** | Deploy ke baad contract badal nahi sakta | `PowInscription.sol` constants: `BLOCK_REWARD`, `TARGET_BLOCK_TIME`, `MAX_SUPPLY`; `.env`: difficulty bits, market fee |
| **Smart contract audit** | Asli paisa lagega. Ek bug = sab funds khatam | Audit firm (Cantina, Code4rena contest, Sherlock, Hacken), ya kam budget mein ek experienced freelance auditor. Minimum: 2 independent reviews |
| **Explorer pe verify** | Log contract code padh sakein → trust | Blockscout verify (hardhat-verify plugin) |
| **Fresh deployer wallet** | Testnet wali key chat mein share ho chuki hai | Naya wallet, ideally hardware wallet (Ledger/Trezor) |
| **Fee wallet = multisig** | Ek key leak = saari fee chori | Safe (safe.global) multisig, 2-of-3 signers. Market `setFee` / `transferOwnership` se owner multisig ko do |
| **Legal check** | Token + marketplace = regulations lag sakte hain | Apne desh ke crypto lawyer se ek baar baat karo (India: VDA tax / TDS rules) |
| **Terms + disclaimer page** | "Financial advice nahi hai", "risk apna" | Website footer mein link |

## Phase 3: Website hosting (HTTPS)

**Vercel (free, recommended):**
1. GitHub repo Vercel se connect karo → New Project → repo select karo.
2. Root directory = repo root. `vercel.json` already bana hua hai (build: `npm run build -w web`, output: `web/dist`).
3. Deploy. `https://<naam>.vercel.app` mil jayega.
4. Apna domain (jaise `xyzmine.com`) Vercel → Settings → Domains mein add karo.

**Environment variables (Vercel → Settings → Environment Variables):**
- `VITE_WC_PROJECT_ID`: WalletConnect project ID (free, https://cloud.reown.com). Isse phone wallets QR se connect hote hain.
- `VITE_RPC_URL`: apna private RPC (neeche dekho). Public RPC pe traffic badhne pe rate limit lagegi.
- `VITE_CONTRACT_ADDRESS` / `VITE_MARKET_ADDRESS`: optional override. Warna `deployment.json` se aata hai.

**Private RPC:** Alchemy, QuickNode ya Chainstack mein Robinhood Chain ka endpoint lo. Free tier se shuru karo, users badhne pe paid.

## Phase 4: Mainnet launch
1. `contracts/.env` mein `RH_MAINNET_RPC`, `RH_MAINNET_CHAIN_ID` bharo (official docs se), aur naya `PRIVATE_KEY`.
2. `web/src/config.js` mein mainnet chain add karo (testnet jaisa hi block, naya chainId/RPC/explorer).
3. `npx hardhat run scripts/deploy.js --network robinhood` (contracts folder mein).
4. Market ownership multisig ko transfer karo.
5. Website ka `deployment.json` mainnet wala commit karo → Vercel auto-deploy.
6. Launch announce karo: exact **launch time** batao, taaki sab ek saath start karein (fair launch).

## Phase 5: Launch ke baad (monitoring)
- **Uptime:** UptimeRobot (free) se website + RPC ping.
- **Errors:** Sentry (free tier) web app mein add karo. Users ke browser errors dikhenge.
- **Analytics:** Plausible ya Umami (privacy-friendly). Kitne log mine kar rahe hain.
- **Indexer:** jab orders/trades hazaaron mein ho jayein, toh browser se saare events padhna slow hoga. Tab **The Graph / Goldsky / Ponder** se indexer banao (price chart, 24h volume, leaderboard ke liye bhi chahiye).
- **Community:** Telegram / Discord + X (Twitter) pe block milestones auto-post karne wala bot.

---

## Checklist (print karke rakh lo)
- [ ] Testnet pe 1-2 hafte, 10+ users
- [ ] Parameters final
- [ ] Audit done + issues fixed
- [ ] Fresh mainnet wallet (hardware)
- [ ] Market owner = multisig
- [ ] Contracts verified on explorer
- [ ] Private RPC + Vercel env vars
- [ ] Custom domain + HTTPS
- [ ] Terms/disclaimer page
- [ ] Sentry + uptime monitor
- [ ] Launch time announced
