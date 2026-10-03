# Claim Site Architecture (Robinhood Chain, EVM L2)

Token: TOKEN_NAME | Total supply: 100,000,000,000 | Decimals: 18
Chain: Robinhood Chain (Ethereum L2). EVM, so standard ERC-20 + Solidity + MetaMask.
Chain ID / RPC / explorer: take from official Robinhood Chain docs, put in `CONFIG` in web/index.html.

## Components
1. **contracts/ClaimToken.sol** - ERC-20, fixed 100B supply minted to owner. Transfers locked until `enableTrading()`.
2. **contracts/MerkleClaim.sol** - one claim per index, verifies Merkle proof, pays from its own balance.
3. **scripts/build-merkle.mjs** - data/wallets.csv -> data/merkle.json (root + proofs, OZ-compatible leaves).
4. **web/index.html** - connect wallet (auto add/switch chain), check eligibility, call `claim()`.

## Deploy order
1. Deploy ClaimToken(name, symbol, owner).
2. `node scripts/build-merkle.mjs` with the final wallet list.
3. Deploy MerkleClaim(token, root).
4. `token.setTransferAllowed(claimContract, true)`; transfer the claim pool to claimContract.
5. Fill CONFIG in web/index.html, host web/ + merkle.json.
6. Launch day: add liquidity from owner (owner is whitelisted), then `token.enableTrading()`.

## Trading freeze
Claimed tokens reach wallets, but wallet-to-wallet and DEX transfers revert until `enableTrading()`.
It is one-way (cannot be re-disabled). Disclose this publicly with a launch date; hidden transfer locks look like a honeypot and get flagged by scanners.
Alternative with zero trust issues: just don't add liquidity until launch.

## Before mainnet
- Contracts are untested/unaudited: write Foundry/Hardhat tests and get a review. Test on testnet first.
- Whitelist for pool/router if you add liquidity (owner address already allowed).
