import { loadConfig } from "../src/config.js";
import { FileChain } from "../src/chain/file.js";

// DEMO: nakli blocks banao (confirmations badhte hain).  usage: npm run chain:mine -- <blocks>
const n = Number(process.argv[2] ?? 1);
const cfg = loadConfig();
if (cfg.network === "mainnet") throw new Error("Demo chain mainnet pe nahi chalti");
const tip = new FileChain(cfg.fakeChainFile).mine(n);
console.log(`${n} block(s) mine hue. Chain tip = ${tip}`);
