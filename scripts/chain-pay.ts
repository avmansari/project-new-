import { loadConfig } from "../src/config.js";
import { FileChain } from "../src/chain/file.js";
import { formatZec, parseZec } from "../src/money.js";

// DEMO: nakli blockchain pe payment bhejo.  usage: npm run chain:pay -- <address> <amountZEC>
const [address, amount] = process.argv.slice(2);
if (!address || !amount) {
  console.error("Usage: npm run chain:pay -- <address> <amountZEC>");
  process.exit(1);
}
const cfg = loadConfig();
if (cfg.network === "mainnet") throw new Error("Demo chain mainnet pe nahi chalti");
const txid = new FileChain(cfg.fakeChainFile).pay(address, parseZec(amount));
console.log(`Nakli payment bheji: ${formatZec(parseZec(amount))} ZEC -> ${address}\n  txid=${txid} (abhi 0 confirmations)`);
