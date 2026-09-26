#!/usr/bin/env node
// Headless CPU miner for servers / PCs.  Usage:  PRIVATE_KEY=0x.. node index.js
import "dotenv/config";
import os from "node:os";
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { createPublicClient, createWalletClient, http, defineChain, formatEther, parseEventLogs, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { leadingZeroBits, hexToBytes, rewardFor, expectedHashes } from "@pow/shared";

const deployment = JSON.parse(fs.readFileSync(new URL("./deployment.json", import.meta.url)));
const RPC_URL = process.env.RPC_URL || (deployment.chainId === 31337 ? "http://127.0.0.1:8545" : "https://rpc.testnet.chain.robinhood.com");
const CONTRACT = process.env.CONTRACT || deployment.address;
const THREADS = Number(process.env.THREADS || Math.max(1, os.cpus().length - 1));
const MAX_BLOCKS = Number(process.env.MAX_BLOCKS || Infinity); // stop after N mined blocks (testing)
if (!process.env.PRIVATE_KEY) {
  console.error("Set PRIVATE_KEY (the miner/gas wallet). Optional: PAYOUT, RPC_URL, CONTRACT, THREADS");
  process.exit(1);
}

const chain = defineChain({
  id: deployment.chainId,
  name: deployment.network,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const PAYOUT = isAddress(process.env.PAYOUT || "") ? process.env.PAYOUT : account.address;
const pub = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ account, chain, transport: http() });
const c = { address: CONTRACT, abi: deployment.abi };

let workers = [];
let current = null; // mining info of the job being mined
let hashes = 0;
let mined = 0;
let submitting = false;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function info() {
  const [challenge, target, height, baseReward, requiredBits] = await pub.readContract({ ...c, functionName: "getMiningInfo" });
  return { challenge, target, height, baseReward, requiredBits: Number(requiredBits) };
}

function stopWorkers() {
  workers.forEach((w) => w.terminate());
  workers = [];
}

function startWorkers(job) {
  stopWorkers();
  current = job;
  log(`⛏  block #${job.height} | ${job.requiredBits} bits | ${THREADS} threads | challenge ${job.challenge.slice(0, 18)}…`);
  for (let i = 0; i < THREADS; i++) {
    const w = new Worker(new URL("./worker.js", import.meta.url), {
      workerData: { challenge: job.challenge, miner: account.address, target: job.target.toString(), workerIndex: i },
    });
    w.on("message", (m) => {
      if (m.type === "hashes") hashes += m.n;
      else if (m.type === "found" && current === job) onFound(job, BigInt(m.nonce), m.digest);
    });
    workers.push(w);
  }
}

async function onFound(job, nonce, digest) {
  stopWorkers();
  submitting = true;
  const bits = leadingZeroBits(hexToBytes(digest));
  const expected = rewardFor(job.height, job.requiredBits, bits);
  log(`💎 solved #${job.height}: ${bits} zero bits (need ${job.requiredBits}) → can mint ${formatEther(expected)} tokens. Submitting…`);
  try {
    const hash = await wallet.writeContract({ ...c, functionName: "mint", args: [nonce, job.challenge, PAYOUT] });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    const [ev] = parseEventLogs({ abi: deployment.abi, logs: receipt.logs, eventName: "BlockMined" });
    mined++;
    log(`✅ minted ${formatEther(ev.args.reward)} for block #${ev.args.height} (tx ${hash})`);
  } catch (e) {
    log(`❌ mint failed: ${e.shortMessage || e.message}`);
  } finally {
    submitting = false;
    current = null;
    if (mined >= MAX_BLOCKS) {
      log(`done: mined ${mined} block(s)`);
      process.exit(0);
    }
  }
}

async function tick() {
  if (submitting) return;
  try {
    const i = await info();
    if (!current || i.challenge !== current.challenge || i.target !== current.target) {
      if (current) log("↻ new block on chain, switching job");
      startWorkers(i);
    }
  } catch (e) {
    log("RPC error:", e.shortMessage || e.message);
  }
}

log(`miner ${account.address} → payout ${PAYOUT} | contract ${CONTRACT} | rpc ${RPC_URL}`);
setInterval(tick, 2000);
setInterval(() => {
  if (!current) return;
  const rate = hashes / 10;
  hashes = 0;
  const eta = rate ? expectedHashes(current.target) / rate : Infinity;
  log(`   ${(rate / 1000).toFixed(1)} kH/s · expected ~${eta.toFixed(0)}s per block`);
}, 10_000);
tick();
