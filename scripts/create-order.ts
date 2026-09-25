import { createChain } from "../src/chain/index.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { formatZec } from "../src/money.js";
import { createOrder, OrderError } from "../src/services/orders.js";

// usage: npm run order:new -- <collectionSlug> <quantity> <buyerTAddress>
const [slug, qty, buyer] = process.argv.slice(2);
if (!slug || !qty || !buyer) {
  console.error("Usage: npm run order:new -- <collectionSlug> <quantity> <buyerTAddress>");
  process.exit(1);
}
const cfg = loadConfig();
const db = await openDb(cfg.dbDir);
try {
  // Chain ka tip (order isse pehle ke payments nahi ginta). Server na mile to order NAHI banta.
  const chain = createChain(cfg);
  const tipHeight = chain.tipHeight ? await chain.tipHeight() : undefined;
  (chain as { close?: () => void }).close?.();
  const o = await createOrder(db, cfg, { collectionSlug: slug, quantity: Number(qty), buyerAddress: buyer, tipHeight });
  console.log(`\nOrder ban gaya: ${o.id}`);
  console.log(`  Bhejna hai : ${formatZec(o.amountZats)} ZEC (EXACT amount)`);
  console.log(`  Is address pe: ${o.payAddress}`);
  console.log(`  NFT milega : ${o.buyerAddress}`);
  console.log(`  Expiry     : ${o.expiresAt.toISOString()}\n`);
} catch (e) {
  if (e instanceof OrderError) console.error(`Order fail [${e.code}]: ${e.message}`);
  else throw e;
  process.exitCode = 1;
}
await db.close();
