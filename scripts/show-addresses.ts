import { loadConfig } from "../src/config.js";
import { deriveReceiveAddress } from "../src/zcash/address.js";

const cfg = loadConfig();
const count = Number(process.argv[2] ?? 5);
console.log(`Network: ${cfg.network}`);
for (let i = 0; i < count; i++) {
  console.log(`[${i}] ${deriveReceiveAddress(cfg.walletXpub, i, cfg.network)}`);
}
