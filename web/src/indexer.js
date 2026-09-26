// Lightweight in-browser indexer.
// Loads every event of the token + market contracts from the deploy block, caches them in localStorage,
// then only fetches new blocks every few seconds. Powers the leaderboard, network stats, price chart,
// 24h market stats, holders count and the activity history.
//
// Good for launch scale (thousands of events). When it grows beyond that, swap `load()` for a hosted
// indexer (The Graph / Goldsky / Ponder) that returns the same arrays — the UI does not need to change.
import * as chain from "./chain.js";
import { CHAIN, DEPLOY_BLOCK } from "./config.js";

const POLL_MS = 8000;
const MAX_CHUNK = 50_000n; // blocks per getLogs call (halved automatically if the RPC refuses)
const MIN_CHUNK = 500n;

// JSON with bigint support (for the localStorage cache)
const replacer = (_k, v) => (typeof v === "bigint" ? { $b: v.toString() } : v);
const reviver = (_k, v) => (v && typeof v === "object" && "$b" in v ? BigInt(v.$b) : v);

function source(contract, name) {
  const key = `pow-idx:v1:${CHAIN.id}:${contract.address.toLowerCase()}`;
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(key), reviver);
  } catch {}
  const valid = cached && BigInt(cached.deployBlock ?? -1) === DEPLOY_BLOCK;
  return {
    name,
    contract,
    key,
    nextBlock: valid ? BigInt(cached.nextBlock) : DEPLOY_BLOCK,
    events: valid ? cached.events : [],
    chunk: MAX_CHUNK,
  };
}

function save(src) {
  try {
    localStorage.setItem(src.key, JSON.stringify({ deployBlock: DEPLOY_BLOCK, nextBlock: src.nextBlock, events: src.events }, replacer));
  } catch {
    // storage full / private mode: keep working from memory
  }
}

async function catchUp(src, latest) {
  let added = 0;
  while (src.nextBlock <= latest) {
    const to = src.nextBlock + src.chunk - 1n > latest ? latest : src.nextBlock + src.chunk - 1n;
    let logs;
    try {
      logs = await chain.getDecodedLogs(src.contract.address, src.contract.abi, src.nextBlock, to);
    } catch (e) {
      if (src.chunk > MIN_CHUNK) {
        src.chunk /= 2n; // RPC range limit: retry with a smaller window
        continue;
      }
      throw e;
    }
    for (const l of logs) {
      if (!l.eventName) continue;
      src.events.push({ event: l.eventName, args: l.args, block: l.blockNumber, tx: l.transactionHash, logIndex: l.logIndex });
    }
    added += logs.length;
    src.nextBlock = to + 1n;
  }
  if (added) save(src);
  return added;
}

const listeners = new Set();
const sources = [];
let running = false;
let loaded = false;

export const indexer = {
  /** Events of one contract: "token" | "market", optionally filtered by event name. */
  events(name, eventName) {
    const src = sources.find((s) => s.name === name);
    if (!src) return [];
    return eventName ? src.events.filter((e) => e.event === eventName) : src.events;
  },
  isLoaded: () => loaded,
  /** fn() is called after every update (and immediately if data is already loaded). */
  subscribe(fn) {
    listeners.add(fn);
    if (loaded) fn();
    return () => listeners.delete(fn);
  },
  async refresh() {
    const latest = await chain.publicClient.getBlockNumber();
    let added = 0;
    for (const s of sources) added += await catchUp(s, latest);
    const first = !loaded;
    loaded = true;
    if (added || first) listeners.forEach((fn) => fn());
  },
  start() {
    if (running) return;
    running = true;
    sources.push(source(chain.TOKEN, "token"));
    if (chain.MARKET_CONTRACT) sources.push(source(chain.MARKET_CONTRACT, "market"));
    const tick = () =>
      indexer
        .refresh()
        .catch((e) => console.warn("indexer:", e?.shortMessage || e?.message || e))
        .finally(() => setTimeout(tick, POLL_MS));
    tick();
  },
};
