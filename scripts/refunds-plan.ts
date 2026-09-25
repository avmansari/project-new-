import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { formatZec } from "../src/money.js";
import { exportPlanned, planRefunds, planToJson } from "../src/services/refunds.js";

// usage: npm run refunds:plan
const cfg = loadConfig();
const db = await openDb(cfg.dbDir);
const r = await planRefunds(db, cfg);
for (const c of r.created) {
  console.log(`NAYA refund#${c.refundId} order=${c.orderId.slice(0, 8)} gross=${formatZec(c.grossZats)} fee=${formatZec(c.feeZats)}`);
  for (const o of c.outputs) console.log(`    -> ${o.role.padEnd(6)} ${formatZec(o.amountZats)} ZEC  ${o.address}`);
}
for (const s of r.skipped) console.log(`SKIP order=${s.orderId.slice(0, 8)}: ${s.reason}`);

const planned = await exportPlanned(db);
const file = "./data/refund-plan.json";
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, planToJson(planned));
console.log(`\nPlan file: ${file} (${planned.length} planned refund). Naye: ${r.created.length}, skip: ${r.skipped.length}`);
await db.close();
