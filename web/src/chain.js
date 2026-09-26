// Everything that talks to the blockchain: reading mining info, wallets, submitting mints.
import { createPublicClient, createWalletClient, custom, http, formatEther, parseEventLogs } from "viem";
import { CHAIN, CONTRACT_ADDRESS, ABI, DEPLOY_BLOCK } from "./config.js";

export const publicClient = createPublicClient({ chain: CHAIN, transport: http() });
const contract = { address: CONTRACT_ADDRESS, abi: ABI };

export async function getMiningInfo() {
  const r = await publicClient.readContract({ ...contract, functionName: "getMiningInfo" });
  const [challenge, target, height, reward, requiredBits, difficulty, totalSupply, lastBlockTime] = r;
  return { challenge, target, height, reward, requiredBits: Number(requiredBits), difficulty, totalSupply, lastBlockTime };
}

export async function getSymbol() {
  return publicClient.readContract({ ...contract, functionName: "symbol" });
}

export async function balanceOf(addr) {
  return publicClient.readContract({ ...contract, functionName: "balanceOf", args: [addr] });
}

export async function previewReward(miner, nonce) {
  const [reward, digest, valid] = await publicClient.readContract({ ...contract, functionName: "previewReward", args: [miner, nonce] });
  return { reward, digest, valid };
}

export async function recentBlocks(limit = 15) {
  const latest = await publicClient.getBlockNumber();
  // L2 blocks are fast; only scan a recent window (RPCs limit log ranges), never before deployment
  let fromBlock = latest > 50_000n ? latest - 50_000n : 0n;
  if (fromBlock < DEPLOY_BLOCK) fromBlock = DEPLOY_BLOCK;
  const logs = await publicClient.getContractEvents({ ...contract, eventName: "BlockMined", fromBlock });
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

export async function ethBalance(addr) {
  return formatEther(await publicClient.getBalance({ address: addr }));
}

/** Claim the mined block: wallet pops up for approval, tokens go straight into that wallet. */
export async function claimBlock(wallet, { nonce, challenge }) {
  const hash = await wallet.client.writeContract({
    ...contract,
    account: wallet.address,
    functionName: "mint",
    args: [nonce, challenge],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted (someone else probably won this block)");
  const [ev] = parseEventLogs({ abi: ABI, logs: receipt.logs, eventName: "BlockMined" });
  return { hash, ...ev.args };
}

export function explorerTx(hash) {
  const url = CHAIN.blockExplorers?.default?.url;
  return url ? `${url}/tx/${hash}` : null;
}
