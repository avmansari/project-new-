import { createChain } from "../src/chain/index.js";
import { LightwalletdChain } from "../src/chain/lightwalletd.js";
import { createApp } from "../src/app/api.js";
import { formatTick, startWorker } from "../src/app/worker.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";

/**
 * WEBSITE + WATCHER ek hi process mein (embedded database ek hi process khol sakta hai).
 * usage: npm run app     phir browser mein http://127.0.0.1:3000
 */
const cfg = loadConfig();
const db = await openDb(cfg.dbDir);
const chain = createChain(cfg);
if (chain instanceof LightwalletdChain) {
  const i = await chain.assertReady();
  console.log(`Chain: ${i.chainName} height=${i.blockHeight} branch-id=0x${i.branchId.toString(16)} (server: ${i.vendor})`);
} else {
  console.log(`(!) CHAIN_BACKEND=${cfg.chainBackend}: nakli chain. Asli payments ke liye .env mein CHAIN_BACKEND=lightwalletd karo.`);
}

const worker = startWorker(db, chain, cfg, {
  intervalMs: cfg.workerIntervalMs,
  onTick: (r) => {
    const line = formatTick(r);
    if (/CHANGES|MINT|TRACK|RELEASE|errors=[1-9]/.test(line)) console.log(line);
  },
  onError: (e) => console.error("tick failed:", e),
});
const app = createApp({ db, cfg, chain });
app.server.listen(cfg.port, cfg.host, () => {
  console.log(`\nWebsite chalu (${cfg.network}): http://${cfg.host}:${cfg.port}   (Ctrl+C se band)`);
  if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost") console.log("(!) HOST public hai: pehle rate limits aur https (reverse proxy) check karo.");
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  console.log("\nBand ho raha hai...");
  await app.close();
  await worker.stop();
  (chain as { close?: () => void }).close?.();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
