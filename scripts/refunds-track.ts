import { createChain } from "../src/chain/index.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { trackRefunds } from "../src/services/refund-tracker.js";

// Ek baar: sent refunds ka chain pe haal dekho.  usage: npm run refunds:track
const cfg = loadConfig();
const db = await openDb(cfg.dbDir);
const chain = createChain(cfg);
try {
  const r = await trackRefunds(db, chain, cfg);
  if (!r.supported) console.log("Is chain backend mein tracking nahi hai (CHAIN_BACKEND=lightwalletd chahiye).");
  else {
    console.log(`checked=${r.checked} errors=${r.errors}`);
    for (const id of r.confirmed) console.log(`  refund#${id} CONFIRMED`);
    for (const id of r.failed) console.log(`  refund#${id} FAILED (expire ho gayi, dobara plan ho sakti hai: npm run refunds:plan)`);
    for (const id of r.alerts) console.log(`  refund#${id} ALERT: chain pe nahi dikh rahi`);
  }
} finally {
  (chain as { close?: () => void }).close?.();
  await db.close();
}
