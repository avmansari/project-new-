// Everything that talks to the blockchain: mining info, wallet, claim, transfer, marketplace.
import { createPublicClient, createWalletClient, custom, http, formatEther, parseEventLogs } from "viem";
import { CHAIN, CONTRACT_ADDRESS, ABI, DEPLOY_BLOCK, MARKET } from "./config.js";

export const publicClient = createPublicClient({ chain: CHAIN, transport: http() });
const token = { address: CONTRACT_ADDRESS, abi: ABI };
const market = MARKET ? { address: MARKET.address, abi: MARKET.abi } : null;
export const hasMarket = !!market;

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
  if (!address) throw new Error("Wallet ne koi account nahi diya");
  const chainId = await client.getChainId().catch(() => null);
  if (chainId !== CHAIN.id) {
    try {
      await client.switchChain({ id: CHAIN.id });
    } catch {
      try {
        await client.addChain({ chain: CHAIN });
        await client.switchChain({ id: CHAIN.id }).catch(() => {});
      } catch {
        throw new Error(`Wallet mein "${CHAIN.name}" network add/switch nahi hua. Wallet mein manually network add karo (chainId ${CHAIN.id}).`);
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
/** Claim the mined block: wallet pops up for approval, tokens go straight into that wallet. */
export async function claimBlock(wallet, { nonce, challenge }) {
  const { hash, receipt } = await send(wallet, token, "mint", [nonce, challenge]);
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

async function ensureAllowance(wallet, amount, onStep) {
  const allowed = await publicClient.readContract({ ...token, functionName: "allowance", args: [wallet.address, market.address] });
  if (allowed >= amount) return;
  onStep?.("Step 1/2: wallet mein token approve karo…");
  await send(wallet, token, "approve", [market.address, amount]);
  onStep?.("Step 2/2: ab order confirm karo…");
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

export async function listForSale(wallet, lots, pricePerLot, onStep) {
  await ensureAllowance(wallet, BigInt(lots) * (await lotSize()), onStep);
  return send(wallet, market, "list", [BigInt(lots), pricePerLot]);
}

export async function placeBid(wallet, lots, pricePerLot) {
  return send(wallet, market, "bid", [BigInt(lots), pricePerLot], costOf(lots, pricePerLot));
}

export async function buyFromListing(wallet, id, lots, pricePerLot) {
  return send(wallet, market, "buy", [id, BigInt(lots)], costOf(lots, pricePerLot));
}

export async function sellIntoBid(wallet, id, lots, onStep) {
  await ensureAllowance(wallet, BigInt(lots) * (await lotSize()), onStep);
  return send(wallet, market, "sell", [id, BigInt(lots)]);
}

export async function cancelOrder(wallet, id) {
  return send(wallet, market, "cancel", [id]);
}

export function explorerTx(hash) {
  const url = CHAIN.blockExplorers?.default?.url;
  return url ? `${url}/tx/${hash}` : null;
}
