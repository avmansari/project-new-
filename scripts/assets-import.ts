import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { importAssets } from "../src/services/assets.js";

/**
 * Folder ki images ko collection se jodo.
 * usage: npm run assets:import -- <slug> <folder> [--replace]
 * Folder: 1.png, 2.png ... (collection ki supply jitni), optional cover.png, optional 1.json (name/attributes).
 */
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [slug, folder] = args;
if (!slug || !folder) {
  console.error("Usage: npm run assets:import -- <slug> <folder> [--replace]");
  process.exit(1);
}
const cfg = loadConfig();
const db = await openDb(cfg.dbDir);
try {
  const r = await importAssets(db, { slug, dir: resolve(folder), assetsRoot: resolve(cfg.assetsDir), replace: process.argv.includes("--replace") });
  console.log(`Import ho gaya: ${r.count} images${r.coverImported ? " + cover" : ""} (${(r.totalBytes / 1024).toFixed(0)} KB)`);
  if (r.duplicateImages > 0) {
    console.log(`(!) WARNING: ${r.duplicateImages} images doosri images ki bilkul copy hain (${r.count} mein se sirf ${r.uniqueImages} alag). Asli collection mein har token ki image alag honi chahiye.`);
  }
  console.log(`Provenance hash: ${r.provenanceHash}`);
  console.log("(Ye hash mint shuru hone se pehle publish karo. Uske baad art badla nahi ja sakta.)");
} catch (e) {
  console.error("Error:", (e as Error).message);
  process.exitCode = 1;
}
await db.close();
