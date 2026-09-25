import { createChain } from "../src/chain/index.js";
import { LightwalletdChain } from "../src/chain/lightwalletd.js";
import { loadConfig } from "../src/config.js";

// Connection check: npm run chain:info
const cfg = loadConfig();
const chain = createChain(cfg);
if (!(chain instanceof LightwalletdChain)) {
  console.log(`CHAIN_BACKEND=${cfg.chainBackend} hai. Asli chain ke liye .env mein CHAIN_BACKEND=lightwalletd karo.`);
  process.exit(0);
}
try {
  const i = await chain.assertReady();
  console.log(`Server theek hai: chain=${i.chainName} height=${i.blockHeight} branch-id=0x${i.branchId.toString(16)}`);
  console.log(`  vendor=${i.vendor} version=${i.version} taddrSupport=${i.taddrSupport}`);
} catch (e) {
  console.error("Server check FAIL:", (e as Error).message);
  process.exitCode = 1;
}
chain.close();
