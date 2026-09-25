import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { listTokens } from "../src/services/mint.js";

// usage: npm run tokens [-- <collectionSlug>]
const cfg = loadConfig();
const db = await openDb(cfg.dbDir);
const rows = await listTokens(db, process.argv[2]);
if (rows.length === 0) console.log("Abhi koi token mint nahi hua.");
for (const t of rows) console.log(`${t.collectionSlug} #${t.tokenNumber}  owner=${t.ownerAddress}  order=${t.orderId.slice(0, 8)}`);
await db.close();
