# Security review: PowInscription, TokenMarket, TokenPool

> **Important:** this is an internal code review done while building the project (manual line-by-line review
> + targeted regression tests). It is **not** a substitute for an independent professional audit.
> Before mainnet, get at least one external audit (Cantina, Code4rena, Sherlock, Hacken, or an experienced
> independent auditor), because real user funds will be escrowed in these contracts.

## Scope

| Contract | Purpose | Holds user funds? |
|---|---|---|
| `contracts/PowInscription.sol` | PoW mining, ERC-20, claim fee | Only fee ETH in transit (plus `feesOwed` if the fee wallet rejects ETH) |
| `contracts/TokenMarket.sol` | Order book (listings, bids, offers, expiry, quick buy) | **Yes**: escrowed tokens (listings) and ETH (bids, offers) |
| `contracts/TokenPool.sol` | DEX pool (currently **not deployed**) | **Yes**: pool liquidity |

Compiler: Solidity 0.8.28 (checked arithmetic), optimizer 1000 runs, `cancun`. No `delegatecall`, `selfdestruct`,
inline assembly, `tx.origin`, upgradeability or external token callbacks. All three contracts are well under the 24 KB size limit.

## Method
1. Manual review of every external/public function: access control, checks-effects-interactions, reentrancy,
   integer bounds and casts, rounding, ETH/token accounting, denial-of-service paths, admin powers.
2. Invariant checks in tests: contract ETH balance == escrow (+ deferred fees) after every flow; bid/offer escrow never over-paid.
3. Regression tests for every finding: `contracts/test/Security.test.js`.
4. Full suite: **43 passing** (`npm test`).

## Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| H-1 | High | Fee wallet that rejects ETH blocks all mining / trading / swaps | ✅ Fixed |
| M-1 | Medium | USD-mode claim fee had no cap; feed decimals were assumed to be 8 | ✅ Fixed |
| M-2 | Medium | Owner could raise the marketplace fee on listings created earlier | ✅ Fixed |
| L-1 | Low | `transferOwnership` on market/pool emitted no event | ✅ Fixed |
| L-2 | Low | Single-key owner can change fees (within caps) | ⚠️ Mitigate operationally |
| I-1 | Info | Sequencer controls timestamps (difficulty) and `blockhash` on Arbitrum-based chains | Accepted |
| I-2 | Info | The block winner can predict the next challenge a little earlier than others | Accepted |
| I-3 | Info | Standard ERC-20 `approve` race condition | Accepted (standard) |
| I-4 | Info | An offer larger than the listing's remaining lots can't be accepted | By design (UI disables it) |
| I-5 | Info | Payouts to makers/buyers are pushed; a contract wallet that rejects ETH only blocks its own orders | Accepted |

### H-1: Fee wallet that rejects ETH blocks the whole protocol (fixed)
**Where:** `PowInscription.mint`, `TokenMarket._buy / sell / acceptOffer`, `TokenPool.buyLots / sellLots`.
**Issue:** fees were sent with a push call that reverted on failure. If `feeRecipient` were set to a contract that
can't receive ETH (e.g. a wrongly configured multisig), every claim, trade and swap would revert: mining and the market stop.
**Fix:** `_payFee` now tries to push the fee (with a gas cap); if that fails the fee is kept in `feesOwed` and
the user's action still succeeds. `withdrawFees()` (callable by anyone, pays **only** `feeRecipient`) sends it later.
**Tests:** "H-1: a fee wallet that rejects ETH can't block mining…", "H-1: same protection on the marketplace and the pool".

### M-1: USD-mode claim fee uncapped / feed decimals assumed (fixed)
**Where:** `PowInscription.mintFee`, `setUsdFee`.
**Issue:** in USD mode the fee was `mintFeeUsd × 1e18 / price` with no upper bound. A broken or manipulated feed
(e.g. price ≈ 0) would make `mintFee()` enormous, and the website sends exactly `mintFee()`, so users could overpay.
Also the math assumed an 8-decimal feed.
**Fix:** the computed fee is capped at `MAX_MINT_FEE_WEI` (0.01 ETH); feed decimals are read with `decimals()` when the feed is set.
**Tests:** "M-1: a broken USD price feed can never charge more than the 0.01 ETH cap", "M-1: feed decimals are read from the feed".

### M-2: Fee increase applied to existing listings (fixed)
**Where:** `TokenMarket._buy`, `acceptOffer`.
**Issue:** a seller lists at 2%; the owner raises the fee to 5%; the seller's listing is then filled at 5% while they are not present.
**Fix:** each order stores the fee at creation (`Order.feeBps`). Fills of a listing use the **lower** of the stored fee and today's fee
(so fee cuts still help sellers). `sell()` into a bid keeps today's fee, because the seller is the one acting and sees it.
**Test:** "M-2: raising the market fee does not apply to listings created before; lowering does".

### L-1: Missing ownership events (fixed)
`OwnershipTransferred` is now emitted by all three contracts.

### L-2: Single-key owner (operational)
The owner can change the claim fee (≤ 0.01 ETH / ≤ $1), the marketplace/DEX fee (≤ 5%) and the fee wallet. The owner **cannot**
mint tokens, move user balances, touch escrowed orders/offers or pool liquidity, or pause anything.
**Recommendation:** before mainnet transfer ownership of every contract to a **Safe multisig** (2-of-3 or 3-of-5), optionally behind a timelock.

### I-1: Sequencer trust
Difficulty retargeting uses `block.timestamp`, and challenges mix in `blockhash`. On Robinhood Chain (Arbitrum Orbit) the sequencer sets
timestamps within protocol bounds and `blockhash` is not a strong randomness source. Impact is limited to small difficulty/fairness skews;
it can't mint tokens without valid PoW. Accepted.

### I-2: Next-challenge head start
The next challenge is `keccak(challenge, winningDigest, blockhash, height)`. A winner who can predict the block their claim lands in could start
on the next puzzle a few hundred milliseconds early. Low impact on a ~2-minute block; accepted.

### I-3 … I-5
Standard ERC-20 allowance race (use approve-to-0 first if needed); offers need enough lots left on the listing; a maker using a contract wallet
that rejects ETH can only block their own bid/offer refunds.

## What was checked and found OK
- **Reentrancy:** market and pool use a `nonReentrant` guard on every state-changing function; the token updates all state before any ETH is sent.
- **Escrow accounting:** bids/offers escrow exactly `lots × price`; cancels/reclaims refund exactly the remainder; tests assert the contract balance equals escrow after each flow.
- **Payment checks:** `buy` / `buyMany` validate and check `msg.value` before any transfer; overpayment is refunded.
- **Bounds/casts:** lots ≤ 2⁶⁴, price ≤ 2¹²⁸, expiry validated; `uint64/uint128` casts only after checks.
- **PoW:** solutions are bound to `msg.sender` (can't be stolen from the mempool); stale solutions revert cheaply; supply is hard-capped at 21M.
- **Pool:** internal reserves (donations don't move price), minimum liquidity locked, slippage (`maxEth` / `minEthOut`) and deadlines.
- **Admin powers:** all fees are capped in code; no admin path to user funds.

## Before mainnet (checklist)
- [ ] External audit of the final code (after parameters are locked)
- [ ] Ownership of all contracts → Safe multisig
- [ ] Fee wallet = an address that accepts ETH (test with a small transfer); check `feesOwed` stays 0 on the owner dashboard
- [ ] Verify contracts on the explorer
- [ ] Run the full test suite on the exact commit that is deployed
