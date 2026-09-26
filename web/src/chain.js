// Everything that talks to the blockchain: reading mining info, wallets, submitting mints.
import { createPublicClient, createWalletClient, custom, http, formatEther, parseEventLogs } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { CHAIN, CONTRACT_ADDRESS, ABI } from "./config.js";

export const publicClient = createPublicClient({ chain: CHAIN, transport: http() });
const contract = { address: CONTRACT_ADDRESS, abi: ABI };

export async function getMiningInfo() {
  const r = await publicClient.readContract({ ...contract, functionName: "getMiningInfo" });
  const [challenge, target, height, baseReward, requiredBits, difficulty, totalSupply, lastBlockTime] = r;
  return { challenge, target, height, baseReward, requiredBits: Number(requiredBits), difficulty, totalSupply, lastBlockTime };
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
  const fromBlock = latest > 50_000n ? latest - 50_000n : 0n;
  const logs = await publicClient.getContractEvents({ ...contract, eventName: "BlockMined", fromBlock });
  return logs.slice(-limit).reverse().map((l) => l.args);
}

// ---------------- Wallets ----------------
// 1) Injected wallet (MetaMask / Rabby / Coinbase / any in-app mobile browser wallet)
export async function connectInjected() {
  if (!window.ethereum) throw new Error("No wallet found. Open this page inside a wallet app browser, or use Burner mode.");
  const client = createWalletClient({ chain: CHAIN, transport: custom(window.ethereum) });
  const [address] = await client.requestAddresses();
  try {
    await client.switchChain({ id: CHAIN.id });
  } catch {
    await client.addChain({ chain: CHAIN });
  }
  return { kind: "injected", address, client };
}

// 2) Burner wallet: key lives in this browser, signs mints instantly (no popups = wins races).
//    Only needs a little ETH for gas; tokens can be sent to your main wallet via `payout`.
const BURNER_KEY = "pow-burner-key";
export function connectBurner() {
  let pk = null;
  try {
    pk = localStorage.getItem(BURNER_KEY);
  } catch {}
  if (!pk) {
    pk = generatePrivateKey();
    try {
      localStorage.setItem(BURNER_KEY, pk);
    } catch {}
  }
  const account = privateKeyToAccount(pk);
  const client = createWalletClient({ account, chain: CHAIN, transport: http() });
  return { kind: "burner", address: account.address, client, exportKey: () => pk };
}

export async function ethBalance(addr) {
  return formatEther(await publicClient.getBalance({ address: addr }));
}

/** Send the PoW solution. Returns parsed BlockMined event args. */
export async function submitMint(wallet, { nonce, challenge, to }) {
  const hash = await wallet.client.writeContract({
    ...contract,
    account: wallet.kind === "burner" ? wallet.client.account : wallet.address,
    functionName: "mint",
    args: [nonce, challenge, to],
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
