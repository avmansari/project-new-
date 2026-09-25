import { existsSync, readFileSync } from "node:fs";
import { createChain } from "../src/chain/index.js";
import { LightwalletdChain } from "../src/chain/lightwalletd.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { formatZec } from "../src/money.js";
import { listRefunds, markRefundSent } from "../src/services/refunds.js";
import { decodeRawTx } from "../src/zcash/rawtx.js";

/**
 * Signed refunds (data/signed-refunds.json) ko network pe bhejta hai, aur kamyaab hone pe 'sent' mark karta hai.
 * usage: npm run refunds:broadcast [-- data/signed-refunds.json]
 */
const file = process.argv[2] ?? "./data/signed-refunds.json";
if (!existsSync(file)) {
  console.error(`Signed file nahi mili: ${file}  (pehle: npm run refunds:sign)`);
  process.exit(1);
}
const cfg = loadConfig();
const chain = createChain(cfg);
if (!(chain instanceof LightwalletdChain)) {
  console.error("CHAIN_BACKEND=lightwalletd chahiye (.env mein).");
  process.exit(1);
}
const db = await openDb(cfg.dbDir);
try {
  await chain.assertReady();
  const signed = JSON.parse(readFileSync(file, "utf8")) as { refundId: number; orderId: string; txid: string; hex: string }[];
  const status = new Map((await listRefunds(db)).map((r) => [r.id, r.status]));
  for (const s of signed) {
    if (status.get(s.refundId) !== "planned") {
      console.log(`refund#${s.refundId}: status '${status.get(s.refundId)}' hai, skip.`);
      continue;
    }
    const mine = decodeRawTx(Uint8Array.from(Buffer.from(s.hex, "hex")));
    if (mine.txid !== s.txid) throw new Error(`refund#${s.refundId}: file ka txid hex se match nahi karta`);
    try {
      const txid = await chain.broadcast(s.hex);
      await markRefundSent(db, s.refundId, txid, { expiryHeight: mine.expiryHeight });
      const total = mine.outputs.reduce((a, o) => a + o.valueZats, 0n);
      console.log(`refund#${s.refundId} BHEJ DIYA  txid=${txid}  (outputs ${formatZec(total)} ZEC)`);
    } catch (e) {
      console.error(`refund#${s.refundId} FAIL: ${(e as Error).message}   (status 'planned' hi rahega)`);
      process.exitCode = 1;
    }
  }
} finally {
  chain.close();
  await db.close();
}
