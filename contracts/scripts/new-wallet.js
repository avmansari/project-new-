// Creates a fresh TESTNET deployer wallet and saves its key into contracts/.env.
// Usage (from repo root):  npm run new-wallet
// Never overwrites an existing real key.
const fs = require("fs");
const path = require("path");
const { Wallet } = require("ethers");

const envPath = path.join(__dirname, "..", ".env");
const examplePath = path.join(__dirname, "..", ".env.example");

let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : fs.readFileSync(examplePath, "utf8");
const current = env.match(/^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m);
if (current) {
  const w = new Wallet(current[1]);
  console.log("contracts/.env mein PRIVATE_KEY pehle se hai (overwrite nahi kiya).");
  console.log("Deployer address:", w.address);
  process.exit(0);
}

const w = Wallet.createRandom();
env = /^PRIVATE_KEY=.*$/m.test(env) ? env.replace(/^PRIVATE_KEY=.*$/m, `PRIVATE_KEY=${w.privateKey}`) : `PRIVATE_KEY=${w.privateKey}\n${env}`;
fs.writeFileSync(envPath, env);

console.log("✅ Naya testnet wallet bana aur key contracts/.env mein save ho gayi.");
console.log("");
console.log("Deployer address:", w.address);
console.log("");
console.log("Ab is address pe testnet ETH lo:");
console.log("  https://faucet.testnet.chain.robinhood.com");
console.log("  (backup) https://faucet.quicknode.com/robinhood/testnet");
console.log("");
console.log("Phir chalao:  npm run deploy:testnet");
console.log("⚠️  contracts/.env kisi ko share/commit mat karna. Is wallet mein asli paise mat rakhna.");
