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
// Injected wallet (MetaMask / Rabby / Coinbase / any wallet app's in-app browser).
// The SAME wallet mines (its address is inside the hash) and claims (approves the tx) -> tokens land in it.
export async function connectInjected() {
  if (!window.ethereum) throw new Error("Wallet nahi mila. MetaMask install karo, ya phone pe wallet app ke browser mein yeh page kholo.");
  const client = createWalletClient({ chain: CHAIN, transport: custom(window.ethereum) });
  const [address] = await client.requestAddresses();
  try {
    await client.switchChain({ id: CHAIN.id });
  } catch {
    await client.addChain({ chain: CHAIN });
  }
  return { address, client };
}

export function onAccountChange(cb) {
  window.ethereum?.on?.("accountsChanged", (accs) => cb(accs[0]));
}

/** Show the token inside MetaMask's asset list. */
export async function watchToken(symbol) {
  return window.ethereum?.request({
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

// ---------------- Marketplace ----------------
const ONE = 10n ** 18n;
/** ETH (wei) for `amount` tokens at `price` wei/token, rounded up like the contract. */
export const costOf = (amount, price) => (amount * price + ONE - 1n) / ONE;

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

export async function listForSale(wallet, amount, price, onStep) {
  await ensureAllowance(wallet, amount, onStep);
  return send(wallet, market, "list", [amount, price]);
}

export async function placeBid(wallet, amount, price) {
  return send(wallet, market, "bid", [amount, price], costOf(amount, price));
}

export async function buyFromListing(wallet, id, amount, price) {
  return send(wallet, market, "buy", [id, amount], costOf(amount, price));
}

export async function sellIntoBid(wallet, id, amount, onStep) {
  await ensureAllowance(wallet, amount, onStep);
  return send(wallet, market, "sell", [id, amount]);
}

export async function cancelOrder(wallet, id) {
  return send(wallet, market, "cancel", [id]);
}

export function explorerTx(hash) {
  const url = CHAIN.blockExplorers?.default?.url;
  return url ? `${url}/tx/${hash}` : null;
}
