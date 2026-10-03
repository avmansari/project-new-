# Claim Site Architecture

Token: TOKEN_NAME | Total supply: 100,000,000,000 | Decimals: 6 (raw = 100_000_000_000_000_000)
Chain: Solana (SPL token + Merkle distributor)

## Components
1. **web/** - static claim page. Wallet connect, eligibility check, claim button.
2. **scripts/build-merkle.mjs** - reads data/wallets.csv (wallet,amount), outputs data/merkle.json (root + per-wallet proofs).
3. **On-chain** - SPL mint (100B), vault holding the claim pool, Merkle distributor program (one claim per wallet, root stored on-chain).
4. **API (later)** - serves proof for a wallet, rate limiting / anti-bot.

## Flow
wallet connect -> lookup amount + proof in merkle.json -> sign claim tx -> distributor verifies proof, transfers from vault.

## Trading control
Recommended: do NOT create a liquidity pool until launch. No pool = no trading. Announce launch date publicly.
Avoid keeping freeze authority / transfer-hook control; scanners flag it as honeypot risk. If used, disclose it and revoke after launch.

## Supply buckets (edit)
Claim pool / Liquidity / Treasury - percentages TBD.

## TODO
- Final wallet list -> data/wallets.csv
- Deploy mint + distributor, set real root
- Replace placeholder branding in web/
