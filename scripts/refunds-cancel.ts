import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { cancelRefund } from "../src/services/refunds.js";

// usage: npm run refunds:cancel -- <refundId>
const [id] = process.argv.slice(2);
if (!id) {
  console.error("Usage: npm run refunds:cancel -- <refundId>");
  process.exit(1);
}
const db = await openDb(loadConfig().dbDir);
await cancelRefund(db, Number(id));
console.log(`refund#${id} cancel hua, inputs free.`);
await db.close();
