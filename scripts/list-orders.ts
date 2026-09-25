import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { formatZec } from "../src/money.js";
import { listOrders } from "../src/services/orders.js";

const cfg = loadConfig();
const db = await openDb(cfg.dbDir);
const orders = await listOrders(db, 50);
if (orders.length === 0) console.log("Koi order nahi.");
for (const o of orders) {
  console.log(
    `${o.id.slice(0, 8)}  ${o.status.padEnd(13)} qty=${o.quantity} price=${formatZec(o.amountZats)} received=${formatZec(o.receivedZats)} refund_due=${formatZec(o.refundDueZats)} refunded=${formatZec(o.refundedZats)}\n          pay=${o.payAddress}`
  );
}
await db.close();
