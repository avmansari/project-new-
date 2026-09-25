import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { markRefundSent } from "../src/services/refunds.js";

// usage: npm run refunds:sent -- <refundId> <txid>
const [id, txid] = process.argv.slice(2);
if (!id || !txid) {
  console.error("Usage: npm run refunds:sent -- <refundId> <txid>");
  process.exit(1);
}
const db = await openDb(loadConfig().dbDir);
await markRefundSent(db, Number(id), txid);
console.log(`refund#${id} ko 'sent' mark kiya.`);
await db.close();
