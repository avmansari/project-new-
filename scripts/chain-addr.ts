import { createChain } from "../src/chain/index.js";
import { LightwalletdChain } from "../src/chain/lightwalletd.js";
import { loadConfig } from "../src/config.js";
import { formatZec } from "../src/money.js";

// Kisi bhi address pe asli chain se aaye payments dekho: npm run chain:addr -- <tm... address>
const address = process.argv[2];
if (!address) {
  console.error("Usage: npm run chain:addr -- <address>");
  process.exit(1);
}
const cfg = loadConfig();
const chain = createChain(cfg);
if (!(chain instanceof LightwalletdChain)) {
  console.error("CHAIN_BACKEND=lightwalletd chahiye (.env mein).");
  process.exit(1);
}
try {
  await chain.assertReady();
  const outs = await chain.getReceived(address);
  if (outs.length === 0) console.log(`${address}: is address pe (pichhle ${cfg.lwdLookbackBlocks} blocks mein) kuch nahi aaya.`);
  for (const o of outs) console.log(`  ${formatZec(o.amountZats).padStart(12)} ZEC  confirmations=${o.confirmations}  ${o.txid}:${o.vout}`);
} catch (e) {
  console.error("Error:", (e as Error).message);
  process.exitCode = 1;
}
chain.close();
