import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { formatZec, parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";

// usage: npm run collection:new -- <slug> "<name>" <supply> <priceZEC> <maxPerWallet>
//          [--payout <creatorTAddress>] [--fee-bps 100] [--hold-hours 72] [--advance-bps 0]
const flags = new Map<string, string>();
const pos: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags.set(argv[i].slice(2), argv[++i]);
  else pos.push(argv[i]);
}
const [slug, name, supply, price, maxPerWallet] = pos;
if (!slug || !name || !supply || !price || !maxPerWallet) {
  console.error('Usage: npm run collection:new -- <slug> "<name>" <supply> <priceZEC> <maxPerWallet> [--payout <addr>] [--fee-bps N] [--hold-hours N] [--advance-bps N]');
  process.exit(1);
}
const cfg = loadConfig();
const db = await openDb(cfg.dbDir);
const c = await createCollection(db, {
  slug,
  name,
  supply: Number(supply),
  priceZats: parseZec(price),
  maxPerWallet: Number(maxPerWallet),
  network: cfg.network,
  creatorAddress: flags.get("payout"),
  feeBps: flags.has("fee-bps") ? Number(flags.get("fee-bps")) : undefined,
  holdHours: flags.has("hold-hours") ? Number(flags.get("hold-hours")) : undefined,
  advanceBps: flags.has("advance-bps") ? Number(flags.get("advance-bps")) : undefined,
});
console.log(`Collection ban gayi (${cfg.network}): ${c.name} [${c.slug}] supply=${c.supply} price=${formatZec(c.priceZats)} ZEC max/wallet=${c.maxPerWallet} status=${c.status}`);
console.log(`  platform fee=${c.feeBps / 100}%  hold=${c.holdHours}h  advance=${c.advanceBps / 100}%  creator=${c.creatorAddress ?? "(set nahi)"}`);
await db.close();
