import { createChain } from "../src/chain/index.js";
import { LightwalletdChain } from "../src/chain/lightwalletd.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { formatTick, runTick, startWorker } from "../src/app/worker.js";

// Sirf watcher (website ke bina): npm run watch            (har 10 sec)
//                                  npm run watch -- --once  (ek baar)
// Website ke saath sab ek process mein chalane ke liye: npm run app
const once = process.argv.includes("--once");
const cfg = loadConfig();
const db = await openDb(cfg.dbDir);
const chain = createChain(cfg);
if (chain instanceof LightwalletdChain) {
  const i = await chain.assertReady(); // galat network / sync na hua server pe yahin ruk jaata hai
  console.log(`Chain: ${i.chainName} height=${i.blockHeight} branch-id=0x${i.branchId.toString(16)} (server: ${i.vendor})`);
}

if (once) {
  console.log(formatTick(await runTick(db, chain, cfg)));
  await db.close();
} else {
  console.log(`Watcher chalu (${cfg.network}, min ${cfg.minConfirmations} confirmations). Ctrl+C se band.`);
  const w = startWorker(db, chain, cfg, {
    intervalMs: cfg.workerIntervalMs,
    onTick: (r) => console.log(formatTick(r)),
    onError: (e) => console.error("tick failed:", e),
  });
  process.on("SIGINT", async () => {
    await w.stop();
    await db.close();
    process.exit(0);
  });
}
