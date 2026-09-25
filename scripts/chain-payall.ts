import { FileChain } from "../src/chain/file.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { formatZec } from "../src/money.js";
import { listOrders } from "../src/services/orders.js";

/**
 * DEMO: nakli chain pe har PENDING order ka exact amount bhej deta hai (address copy-paste nahi karna padta).
 * usage: npm run chain:payall
 */
const cfg = loadConfig();
if (cfg.network === "mainnet") throw new Error("Demo chain mainnet pe nahi chalti");
const db = await openDb(cfg.dbDir);
const chain = new FileChain(cfg.fakeChainFile);
const now = Date.now();
let paid = 0;
for (const o of await listOrders(db, 500)) {
  if (o.status !== "pending" || o.funded || o.expiresAt.getTime() <= now) continue;
  const already = (await chain.getReceived(o.payAddress)).reduce((a, x) => a + x.amountZats, 0n);
  if (already >= o.amountZats) continue; // pehle hi bheja hua hai
  chain.pay(o.payAddress, o.amountZats - already);
  paid++;
  console.log(`Bheja: ${formatZec(o.amountZats - already)} ZEC -> ${o.payAddress}  (order ${o.id.slice(0, 8)})`);
}
console.log(paid ? `\n${paid} order(s) ka payment bhej diya (0 confirmations). Ab: npm run chain:mine -- 10` : "Koi pending unpaid order nahi mila (shayad expire ho gaye, naye order banao).");
await db.close();
