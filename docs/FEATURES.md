# Feature ideas / roadmap

✅ = done · ⭐ = most recommended · effort: S (hours) · M (1-3 days) · L (a week+)

## Done
- ✅ PoW mining (CPU + GPU + phone), 5,000 tokens/block, per-block difficulty (~2 min/block)
- ✅ Claim straight into the connected wallet
- ✅ **Transfer** tab (send, Max, "Add token to wallet")
- ✅ **Marketplace**: whole lots only (1 lot = 5,000), price per lot, listings + bids, cancel, 1% fee, live updates every 4 s
- ✅ **Multiple wallets**: auto-detect (MetaMask, Rabby, Coinbase, OKX, Trust…), WalletConnect QR, phone deep links
- ✅ Full GPU name (Intel Arc B580, RTX 3060 Ti, RX 6700 XT, Apple M-series, Adreno…), manual override
- ✅ **Fees:** $0.10 per claimed lot + 2% marketplace fee, both to one wallet
- ✅ **Leaderboard**, **network stats page** (hashrate / block time / difficulty charts), **auto-claim**, **sound + notification**
- ✅ **In-browser indexer**, **price chart**, **24h stats + holders**, **activity history**, **quick buy**, **USD estimates**
- ✅ **Landing page + FAQ**, **terms popup**, **USD prices in the marketplace**, **benchmark**, **top 100 holders leaderboard**, **owner alerts**, **Plausible analytics**, **internal security review** ([AUDIT.md](AUDIT.md))
- ✅ **"Mining Console" UI redesign**: sidebar app shell + mobile tab bar, hashrate gauge, puzzle bits bar with your best hash, live hash stream, odds + haul cards, "Block found" popup with confetti, lot-card marketplace with depth order book and live trades, holders podium, landing page with 3D block, live ticker and a 4,200-square block wall
- ✅ **Share card** (Share on X), **order expiry**, **make offer**, **DEX pool** (built, switched off for now), **owner dashboard**, **hosted indexer (Ponder)**

## Mining
| Feature | Why | Effort |
|---|---|---|
| ⭐ **Leaderboard** (top miners, blocks mined, 24h / 7d / all-time, GPU used) | Competition keeps people mining | M |
| ⭐ **Network stats page** (hashrate, block time and difficulty charts, blocks left, % supply mined) | Transparency + hype | M |
| ⭐ **Auto-claim toggle** (wallet popup opens the instant a block is found) | Wins more races | S |
| **Sound + browser notification** when a block is found (even in a background tab) | Users don't miss a claim | S |
| **Benchmark button**: "Your device does X H/s → ~Y min per block at current difficulty" | New users instantly get it | S |
| **Mining pool mode**: everyone mines together, rewards split by submitted shares | Phones get small but regular rewards instead of rarely winning | L |
| **Native desktop miner** (CUDA / OpenCL / Vulkan) | 3-10× faster than browser WebGPU on big GPUs | L |
| **Per-address cooldown / anti-bot rules** | Fairer launch vs. GPU farms | S (contract) |
| **Countdown to launch + "blocks remaining" bar** | Fair launch hype | S |

## Marketplace
| Feature | Why | Effort |
|---|---|---|
| ⭐ **Price chart** (candles 1h / 24h / 7d) | The first thing traders look for (needs an indexer) | M |
| ⭐ **24h stats**: volume, % change, high/low, holders count | Makes the market feel alive | M |
| **Quick buy**: "Buy 3 lots" → auto-fills from the cheapest listings | One-click trading | S |
| **Order expiry** (auto-cancel after 24h / 7d) | Clears stale orders | M (contract) |
| **Floor sweep** (buy several cheapest listings in one tx) | Power users | M (contract) |
| **Prices in USD** (via an ETH price feed) | Normal users don't think in ETH | S |
| **DEX liquidity pool** (Uniswap-style) | Instant swaps without waiting for orders; common after launch | M |
| **Offers on a specific seller / private listings** | OTC deals | M |

## Wallet / UX
| Feature | Why | Effort |
|---|---|---|
| ⭐ **Activity / history tab** (claims, transfers, trades, with explorer links) | Users see their own record | M |
| **Gasless claims** (paymaster / sponsored gas via smart accounts) | New users can mine without first buying ETH | L |
| **Session keys** (EIP-7702 / smart accounts) for popup-free claiming | Faster claims, better race odds | L |
| **Hindi / English toggle** | Bigger audience | S |
| **PWA install** ("Add to Home screen" icon, offline shell) | App-like feel on phones | S |
| **Gas estimate** next to every action button | No surprises | S |
| **Light / dark theme toggle** | Polish | S |

## Community / growth
| Feature | Why | Effort |
|---|---|---|
| ⭐ **Referral links**: referrer earns a share of the marketplace fee from their referrals | Viral growth | M |
| **Telegram / Discord / X bot**: "Block #1234 mined by 0xab… (RTX 4090)" | Hype + FOMO | S |
| **Achievements / badges** (first block, 10 blocks, 100 blocks, top-10 miner) | Retention | M |
| **Inscription gallery**: a generated card/image per mined block | Collectible feel | M |
| **Public API** (blocks, miners, orders as JSON) | Lets others build dashboards and bots | M |

## Operations / safety
| Feature | Why | Effort |
|---|---|---|
| ⭐ **Indexer** (The Graph / Goldsky / Ponder) | Powers charts, leaderboard, history; required at scale | M |
| **Admin dashboard** (fees earned, volume, active miners) | Run the project with data | M |
| **Error tracking + analytics** (Sentry, Plausible) | Find problems before users complain | S |
| **Contract verification + public audit report** | Trust | S (+ audit cost) |

## Suggested order for the next steps
1. **Leaderboard + network stats page + auto-claim**: quick wins that make mining addictive.
2. **Indexer → price chart + 24h stats + activity tab**: turns the marketplace into a real trading venue.
3. **Referral links + Telegram/X bot**: growth before mainnet.
4. **Audit → mainnet** (see [`PRODUCTION.md`](PRODUCTION.md)).
5. After launch: mining pool, gasless claims, DEX pool.
