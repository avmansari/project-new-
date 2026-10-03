# CHOMP Claim

Claim site for CHOMP on Robinhood Chain (EVM L2). 100,000,000,000 supply, 75% community airdrop.
User pastes wallet, presses Claim, pays a small fee (~$0.10 in native coin) + gas, tokens go to that wallet.

```
contracts/ClaimToken.sol   ERC-20, 100B fixed supply, transfers locked until enableTrading()
contracts/MerkleClaim.sol  Merkle claim, one claim per index, claimFee per claim, owner controls
scripts/build-merkle.mjs   data/wallets.csv -> data/merkle.json (root + proofs)
scripts/deploy.cjs         deploys both, whitelists + funds claim contract, writes web/config.js
test/claim.test.cjs        10 contract tests
web/                       static site (index.html, config.js, vendor/). Host this folder.
tools/wc-entry.js          source for web/vendor/walletconnect.bundle.js (`npm run build:wc` to rebuild)
```

## Wallets
The Connect Wallet button lists every browser wallet that supports EIP-6963 (MetaMask, Rabby, Coinbase Wallet,
Trust, OKX, Phantom EVM, Brave, ...) plus WalletConnect for mobile wallets (Rainbow, Trust mobile, etc.).
WalletConnect needs a free project id from https://cloud.reown.com : put it in `WALLETCONNECT_PROJECT_ID` (.env) before deploy,
or in `web/config.js`. Without it the WalletConnect option shows a "not configured" message; browser wallets still work.

## 1. Test everything locally (no real money)
```bash
npm install
npm test                          # contract tests
# put real test wallets in data/wallets.csv (wallet,amount in whole tokens), then:
npm run merkle
npm run node                      # terminal 1: local chain (prints 20 funded accounts + keys)
npm run deploy:local              # terminal 2: rebuilds the list, deploys, writes web/config.js + web/merkle.json
npm run serve                     # open http://localhost:8080
```
To test with your own wallet (it has no ETH on the local chain): `ADDRESS=0xYourWallet npm run fund:local`
(gives 100 test ETH, local node only). Add a local-node account to MetaMask (import one of the printed keys) with network
`http://127.0.0.1:8545`, chain id `31337`. Use a wallet from wallets.csv, press Claim.

## 2. Testnet (Robinhood Chain testnet) - testing phase
Get chain id / RPC / explorer / faucet from the official Robinhood Chain docs, then:
```bash
cp .env.example .env   # fill it in, then: set -a; source .env; set +a
npm run merkle
npm run deploy:robinhood
```
Host `web/` anywhere static (Vercel, Netlify, Cloudflare Pages). Test real claims with a few wallets.

## 3. Production checklist
- [ ] Contracts audited / reviewed by someone independent (tests here are not an audit).
- [ ] Owner = a multisig (set `OWNER=` at deploy), not a hot key. Never commit `.env`.
- [ ] Final wallet list -> `npm run merkle` -> deploy -> **verify contracts on the explorer**.
- [ ] Set `CLAIM_FEE_ETH` to ~$0.10 at the current price; adjust later with `setClaimFee`.
- [ ] Announce the claim fee and the trading date publicly BEFORE launch.
- [ ] Trading: claimed tokens are locked until `token.enableTrading()` (one-way). Add liquidity from the owner wallet (whitelisted), then enable.
- [ ] `claim.withdrawFees(treasury)` for fees; `claim.recoverTokens` for unclaimed tokens after the claim window.
- [ ] Add your art to `web/assets/` (bg.webp, bg2.webp, logo.png).

## Notes
- The claim fee is a fixed native-coin amount (a contract cannot know the USD price). Update it if ETH moves a lot.
- Anyone can submit a claim for a wallet (they pay fee+gas), but tokens always go to the wallet in the proof.

## Troubleshooting
- **"This wallet has nothing to claim"**: the wallet is not in `data/wallets.csv`, or `web/merkle.json` is old. Edit the csv, run `npm run deploy:local` again (it rebuilds the list), hard-refresh the page (Ctrl+Shift+R).
- Local node restarted? Everything resets: run `npm run deploy:local` again, and in MetaMask: Settings > Advanced > Clear activity tab data.
