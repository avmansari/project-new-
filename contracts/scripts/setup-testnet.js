// One-command testnet launch:  npm run testnet
//  1. asks for your private key (or makes a new wallet), saves it in contracts/.env
//  2. checks chain + ETH balance (waits for faucet if 0)
//  3. deploys the contract and wires web + CLI to it
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");
const { Wallet, JsonRpcProvider, formatEther } = require("ethers");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const NETWORK = process.argv[2] || "robinhoodTestnet";
const RPC = NETWORK === "localhost" ? "http://127.0.0.1:8545" : process.env.RH_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com/rpc";
const FAUCET = "https://faucet.testnet.chain.robinhood.com";
const envPath = path.join(__dirname, "..", ".env");
const examplePath = path.join(__dirname, "..", ".env.example");

const ask = (q) =>
  new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      res(a.trim());
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function saveKey(pk) {
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : fs.readFileSync(examplePath, "utf8");
  env = /^PRIVATE_KEY=.*$/m.test(env) ? env.replace(/^PRIVATE_KEY=.*$/m, `PRIVATE_KEY=${pk}`) : `PRIVATE_KEY=${pk}\n${env}`;
  fs.writeFileSync(envPath, env);
}

async function main() {
  console.log(`\n=== PoW Inscription → ${NETWORK} setup ===\n`);

  // 1) key
  let pk = /^0x[0-9a-fA-F]{64}$/.test(process.env.PRIVATE_KEY || "") ? process.env.PRIVATE_KEY : null;
  if (pk) {
    console.log("contracts/.env mein key mili, wahi use kar raha hoon.");
  } else {
    const a = await ask("Private key paste karo (ya Enter dabao naya wallet banane ke liye): ");
    if (!a) {
      pk = Wallet.createRandom().privateKey;
      console.log("Naya wallet bana diya.");
    } else {
      pk = a.startsWith("0x") ? a : "0x" + a;
      if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("Key galat hai: 64 hex characters honi chahiye.");
    }
    saveKey(pk);
    console.log("Key contracts/.env mein save ho gayi (yeh file git mein nahi jaati).");
  }
  const wallet = new Wallet(pk);
  console.log("Deployer address:", wallet.address);

  // 2) chain + balance
  const provider = new JsonRpcProvider(RPC);
  const net = await provider.getNetwork().catch((e) => {
    throw new Error(`RPC se connect nahi hua (${RPC}): ${e.shortMessage || e.message}`);
  });
  console.log(`Connected: chainId ${net.chainId}`);
  let bal = await provider.getBalance(wallet.address);
  if (bal === 0n) {
    console.log(`\nBalance 0 ETH hai. Is address pe faucet se testnet ETH lo:\n  ${FAUCET}\n  address: ${wallet.address}\n`);
    process.stdout.write("ETH ka wait kar raha hoon");
    while (bal === 0n) {
      await sleep(5000);
      process.stdout.write(".");
      bal = await provider.getBalance(wallet.address);
    }
    console.log("");
  }
  console.log(`Balance: ${formatEther(bal)} ETH ✅\n`);

  // 3) deploy
  const r = spawnSync("npx", ["hardhat", "run", "scripts/deploy.js", "--network", NETWORK], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) throw new Error("Deploy fail hua (upar error dekho).");

  console.log(`
🎉 Done! Ab:
  1) npm run web          → http://localhost:5173 pe mining test karo
  2) web/src/deployment.json + miner-cli/deployment.json ko git commit + push karo
  3) Vercel pe repo import karo → phone ke liye HTTPS link milega
`);
}

main().catch((e) => {
  console.error("\n❌", e.message);
  process.exitCode = 1;
});
