// Everything that talks to the blockchain: mining info, wallet, claim, transfer, marketplace.
import { createPublicClient, createWalletClient, custom, http, formatEther, parseEventLogs } from "viem";
import { CHAIN, CONTRACT_ADDRESS, ABI, DEPLOY_BLOCK, MARKET, POOL } from "./config.js";

export const publicClient = createPublicClient({ chain: CHAIN, transport: http() });
const token = { address: CONTRACT_ADDRESS, abi: ABI };
const market = MARKET ? { address: MARKET.address, abi: MARKET.abi } : null;
const pool = POOL ? { address: POOL.address, abi: POOL.abi } : null;
export const hasMarket = !!market;
export const hasPool = !!pool;

// ---------------- Mining reads ----------------
export async function getMiningInfo() {
  const r = await publicClient.readContract({ ...token, functionName: "getMiningInfo" });
  const [challenge, target, height, reward, requiredBits, difficulty, totalSupply, lastBlockTime] = r;
  return { challenge, target, height, reward, requiredBits: Number(requiredBits), difficulty, totalSupply, lastBlockTime };
}

export async function getSymbol() {
  return publicClient.readContract({ ...token, functionName: "symbol" });
}

export async function balanceOf(addr) {
  return publicClient.readContract({ ...token, functionName: "balanceOf", args: [addr] });
}

export async function ethBalanceWei(addr) {
  return publicClient.getBalance({ address: addr });
}

export async function ethBalance(addr) {
  return formatEther(await ethBalanceWei(addr));
}

async function logWindow() {
  // L2 blocks are fast; only scan a recent window (RPCs limit log ranges), never before deployment
  const latest = await publicClient.getBlockNumber();
  let fromBlock = latest > 50_000n ? latest - 50_000n : 0n;
  if (fromBlock < DEPLOY_BLOCK) fromBlock = DEPLOY_BLOCK;
  return fromBlock;
}

export async function recentBlocks(limit = 15) {
  const logs = await publicClient.getContractEvents({ ...token, eventName: "BlockMined", fromBlock: await logWindow() });
  return logs.slice(-limit).reverse().map((l) => l.args);
}

// ---------------- Wallet ----------------
// Works with any EIP-1193 provider (extension wallet or WalletConnect) picked in wallets.js.
// The SAME wallet mines (its address is inside the hash) and claims (approves the tx) -> tokens land in it.
export async function connectProvider(provider, { silent = false } = {}) {
  const client = createWalletClient({ chain: CHAIN, transport: custom(provider) });
  const [address] = silent ? await client.getAddresses() : await client.requestAddresses();
  if (!address) throw new Error("The wallet returned no account");
  const chainId = await client.getChainId().catch(() => null);
  if (chainId !== CHAIN.id) {
    try {
      await client.switchChain({ id: CHAIN.id });
    } catch {
      try {
        await client.addChain({ chain: CHAIN });
        await client.switchChain({ id: CHAIN.id }).catch(() => {});
      } catch {
        throw new Error(`Could not add/switch to the "${CHAIN.name}" network. Please add it manually in your wallet (chainId ${CHAIN.id}).`);
      }
    }
  }
  return { address, client, provider };
}

export function onAccountChange(provider, cb) {
  provider?.on?.("accountsChanged", (accs) => cb(accs?.[0] ?? null));
}

/** Show the token inside the wallet's asset list. */
export async function watchToken(wallet, symbol) {
  return wallet?.provider?.request({
    method: "wallet_watchAsset",
    params: { type: "ERC20", options: { address: CONTRACT_ADDRESS, symbol, decimals: 18 } },
  });
}

async function send(wallet, contract, functionName, args, value) {
  const hash = await wallet.client.writeContract({ ...contract, account: wallet.address, functionName, args, value });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted");
  return { hash, receipt };
}

// ---------------- Claim ----------------
/** Current claim fee in wei (~$0.10, paid in ETH to the project fee wallet). */
export async function mintFee() {
  return publicClient.readContract({ ...token, functionName: "mintFee" });
}

/** Claim the mined block: wallet pops up for approval, tokens go straight into that wallet. */
export async function claimBlock(wallet, { nonce, challenge }) {
  const fee = await mintFee();
  const { hash, receipt } = await send(wallet, token, "mint", [nonce, challenge], fee);
  const [ev] = parseEventLogs({ abi: ABI, logs: receipt.logs, eventName: "BlockMined" });
  return { hash, ...ev.args };
}

// ---------------- Transfer ----------------
export async function transferTokens(wallet, to, amount) {
  return send(wallet, token, "transfer", [to, amount]);
}

// ---------------- Marketplace (whole lots only) ----------------
/** ETH (wei) for `lots` at `pricePerLot` wei — exact, same as the contract. */
export const costOf = (lots, pricePerLot) => BigInt(lots) * pricePerLot;

let _lotSize;
/** Token units per lot (5,000 tokens = 1 mined block). */
export async function lotSize() {
  _lotSize ??= await publicClient.readContract({ ...market, functionName: "lotSize" });
  return _lotSize;
}

async function ensureAllowance(wallet, amount, onStep, spender = market.address) {
  const allowed = await publicClient.readContract({ ...token, functionName: "allowance", args: [wallet.address, spender] });
  if (allowed >= amount) return;
  onStep?.("Step 1/2: approve the token in your wallet…");
  await send(wallet, token, "approve", [spender, amount]);
  onStep?.("Step 2/2: now confirm…");
}

/** All orders (open + closed) — fine for the early market; move to an indexer when it grows. */
export async function getOrders() {
  const n = await publicClient.readContract({ ...market, functionName: "ordersCount" });
  const out = [];
  for (let from = 0n; from < n; from += 200n) {
    const page = await publicClient.readContract({ ...market, functionName: "getOrders", args: [from, 200n] });
    page.forEach((o, i) => out.push({ id: from + BigInt(i), ...o }));
  }
  return out;
}

export async function recentTrades(limit = 30) {
  const logs = await publicClient.getContractEvents({ ...market, eventName: "Trade", fromBlock: await logWindow() });
  return logs.slice(-limit).reverse().map((l) => ({ ...l.args, tx: l.transactionHash }));
}

export async function marketFeeBps() {
  return publicClient.readContract({ ...market, functionName: "feeBps" });
}

/** expiry: unix seconds (0 = never) */
export async function listForSale(wallet, lots, pricePerLot, onStep, expiry = 0n) {
  await ensureAllowance(wallet, BigInt(lots) * (await lotSize()), onStep);
  return send(wallet, market, "list", [BigInt(lots), pricePerLot, BigInt(expiry)]);
}

export async function placeBid(wallet, lots, pricePerLot, expiry = 0n) {
  return send(wallet, market, "bid", [BigInt(lots), pricePerLot, BigInt(expiry)], costOf(lots, pricePerLot));
}

// ---- offers on a specific listing
export async function getOffers() {
  const n = await publicClient.readContract({ ...market, functionName: "offersCount" });
  const out = [];
  for (let from = 0n; from < n; from += 200n) {
    const page = await publicClient.readContract({ ...market, functionName: "getOffers", args: [from, 200n] });
    page.forEach((o, i) => out.push({ id: from + BigInt(i), ...o }));
  }
  return out;
}
export const makeOffer = (wallet, listingId, lots, pricePerLot, expiry = 0n) =>
  send(wallet, market, "makeOffer", [listingId, BigInt(lots), pricePerLot, BigInt(expiry)], costOf(lots, pricePerLot));
export const acceptOffer = (wallet, offerId) => send(wallet, market, "acceptOffer", [offerId]);
export const cancelOffer = (wallet, offerId) => send(wallet, market, "cancelOffer", [offerId]);
export const reclaimExpired = (wallet, id) => send(wallet, market, "reclaimExpired", [id]);
export const reclaimExpiredOffer = (wallet, offerId) => send(wallet, market, "reclaimExpiredOffer", [offerId]);

// ---------------- DEX pool (whole lots) ----------------
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

export async function poolState(addr) {
  const r = (fn, args = []) => publicClient.readContract({ ...pool, functionName: fn, args });
  const [reserveToken, reserveEth, totalSupply, feeBps, price] = await Promise.all([
    r("reserveToken"),
    r("reserveEth"),
    r("totalSupply"),
    r("protocolFeeBps"),
    r("priceOfLot"),
  ]);
  const lp = addr ? await r("balanceOf", [addr]) : 0n;
  return { reserveToken, reserveEth, totalSupply, feeBps, price, lp };
}
export const quotePoolBuy = (lots) => publicClient.readContract({ ...pool, functionName: "quoteBuy", args: [BigInt(lots)] });
export const quotePoolSell = (lots) => publicClient.readContract({ ...pool, functionName: "quoteSell", args: [BigInt(lots)] });

/** slippageBps: extra ETH allowed on buys / less ETH accepted on sells (default 1%). */
export async function poolBuy(wallet, lots, slippageBps = 100n) {
  const [total] = await quotePoolBuy(lots);
  return send(wallet, pool, "buyLots", [BigInt(lots), deadline()], (total * (10_000n + slippageBps)) / 10_000n);
}
export async function poolSell(wallet, lots, onStep, slippageBps = 100n) {
  await ensureAllowance(wallet, BigInt(lots) * (await lotSize()), onStep, pool.address);
  const [net] = await quotePoolSell(lots);
  return send(wallet, pool, "sellLots", [BigInt(lots), (net * (10_000n - slippageBps)) / 10_000n, deadline()]);
}
export async function poolAdd(wallet, ethWei, maxTokens, onStep) {
  await ensureAllowance(wallet, maxTokens, onStep, pool.address);
  return send(wallet, pool, "addLiquidity", [maxTokens, 0n, deadline()], ethWei);
}
export const poolRemove = (wallet, liquidity) => send(wallet, pool, "removeLiquidity", [liquidity, 0n, 0n, deadline()]);

export async function buyFromListing(wallet, id, lots, pricePerLot) {
  return send(wallet, market, "buy", [id, BigInt(lots)], costOf(lots, pricePerLot));
}

export async function sellIntoBid(wallet, id, lots, onStep) {
  await ensureAllowance(wallet, BigInt(lots) * (await lotSize()), onStep);
  return send(wallet, market, "sell", [id, BigInt(lots)]);
}

/** Quick buy: fill several listings in one tx. fills = [{ id, lots, pricePerLot }] */
export async function buyMany(wallet, fills) {
  const total = fills.reduce((s, f) => s + costOf(f.lots, f.pricePerLot), 0n);
  return send(wallet, market, "buyMany", [fills.map((f) => f.id), fills.map((f) => BigInt(f.lots))], total);
}

export async function cancelOrder(wallet, id) {
  return send(wallet, market, "cancel", [id]);
}

export function explorerTx(hash) {
  const url = CHAIN.blockExplorers?.default?.url;
  return url ? `${url}/tx/${hash}` : null;
}

// ---------------- raw logs (used by the indexer) ----------------
export const TOKEN = token;
export const MARKET_CONTRACT = market;
export const POOL_CONTRACT = pool;

/** All logs of `address` in [fromBlock, toBlock], decoded with `abi`. */
export async function getDecodedLogs(address, abi, fromBlock, toBlock) {
  const logs = await publicClient.getLogs({ address, fromBlock, toBlock });
  return parseEventLogs({ abi, logs, strict: false });
}

// ---------------- owner / admin ----------------
const CONTRACTS = () => ({ token, market, pool });

/** Read owner + fee settings of all contracts. */
export async function adminInfo() {
  const r = (c, fn, args = []) => (c ? publicClient.readContract({ ...c, functionName: fn, args }) : null);
  const [tokenOwner, feeRecipient, mintFeeWei, fee, marketOwner, marketFee, marketRecipient, poolOwner, poolFee, poolRecipient] = await Promise.all([
    r(token, "owner"),
    r(token, "feeRecipient"),
    r(token, "mintFeeWei"),
    r(token, "mintFee"),
    r(market, "owner"),
    r(market, "feeBps"),
    r(market, "feeRecipient"),
    r(pool, "owner"),
    r(pool, "protocolFeeBps"),
    r(pool, "feeRecipient"),
  ]);
  return { tokenOwner, feeRecipient, mintFeeWei, mintFee: fee, marketOwner, marketFee, marketRecipient, poolOwner, poolFee, poolRecipient };
}

/** Owner-only transaction on "token" | "market" | "pool". */
export function adminCall(wallet, which, functionName, args) {
  return send(wallet, CONTRACTS()[which], functionName, args);
}
