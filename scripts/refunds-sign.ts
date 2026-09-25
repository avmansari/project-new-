import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLightwalletd } from "../src/chain/index.js";
import { loadSignerConfig } from "../src/config.js";
import { promptHidden, promptLine } from "../src/util/prompt.js";
import { assertMnemonicMatchesXpub, parsePlanJson, signRefund, summarizePlan } from "../src/zcash/signer.js";

/**
 * OFFLINE refund signer.  Mnemonic kabhi disk/server pe nahi jaata.
 *
 * npm run refunds:sign -- --fetch [--expiry-delta 200]            (branch-id + tip-height server se khud le leta hai)
 * npm run refunds:sign -- --branch-id <hex> --tip-height <N> [--expiry-delta 200]
 *        [--plan data/refund-plan.json] [--out data/signed-refunds.json] [--mnemonic-file path] [--yes]
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const cfg = loadSignerConfig();
const planFile = arg("plan") ?? "./data/refund-plan.json";
const outFile = arg("out") ?? "./data/signed-refunds.json";
let branchHex = arg("branch-id");
let tip = arg("tip-height");
if (has("fetch")) {
  // Sirf branch-id aur height server se aate hain. Galat mile to tx reject hogi (paisa safe), isliye risk nahi.
  const lwd = createLightwalletd({ network: cfg.network, lwdUrl: process.env.LWD_URL?.trim() || undefined });
  try {
    const i = await lwd.assertReady();
    branchHex = i.branchId.toString(16);
    tip = String(i.blockHeight);
    console.log(`Server se liya: branch-id=0x${branchHex} height=${tip}`);
  } finally {
    lwd.close();
  }
}
const delta = Number(arg("expiry-delta") ?? 200);
if (!branchHex || !/^(0x)?[0-9a-fA-F]{1,8}$/.test(branchHex) || !tip || !/^\d+$/.test(tip)) {
  console.error("Zaroori: --fetch  YA  --branch-id <hex> aur --tip-height <N>");
  process.exit(1);
}
const branchId = parseInt(branchHex.replace(/^0x/, ""), 16);
const expiryHeight = Number(tip) + delta;

if (!existsSync(planFile)) {
  console.error(`Plan file nahi mili: ${planFile}  (pehle: npm run refunds:plan)`);
  process.exit(1);
}
const plan = parsePlanJson(readFileSync(planFile, "utf8"));
if (plan.length === 0) {
  console.log("Plan khaali hai, sign karne ko kuch nahi.");
  process.exit(0);
}

let mnemonic: string;
const mf = arg("mnemonic-file");
if (mf) {
  mnemonic = readFileSync(mf, "utf8").trim().replace(/\s+/g, " ");
  console.log(`(!) Mnemonic file '${mf}' se padhi. Kaam ke baad use SECURELY delete karo.`);
} else {
  mnemonic = (await promptHidden("Mnemonic (24 words, screen pe nahi dikhega): ")).trim().replace(/\s+/g, " ");
}
if (cfg.walletXpub) assertMnemonicMatchesXpub(mnemonic, cfg.walletXpub);
else console.log("(!) WALLET_XPUB set nahi, mnemonic match check nahi ho paya (testnet me chalega).");

console.log(`\nNetwork: ${cfg.network} | branch-id: 0x${branchId.toString(16)} | expiry height: ${expiryHeight}`);
console.log(`Treasury: ${cfg.treasuryAddress ?? "(set nahi)"} | max fee: ${cfg.maxFeeZats} zats\n`);

const signed = [];
for (const item of plan) {
  console.log(summarizePlan(item, mnemonic, cfg.network).join("\n"));
  if (!has("yes")) {
    const a = (await promptLine("\nEk ek address dhyan se check kiya? Sign karne ke liye YES likho: ")).trim();
    if (a !== "YES") {
      console.log("Skip kiya.\n");
      continue;
    }
  }
  const s = signRefund(item, mnemonic, { network: cfg.network, branchId, expiryHeight, treasuryAddress: cfg.treasuryAddress, maxFeeZats: cfg.maxFeeZats });
  console.log(`   SIGNED  txid=${s.txid}\n`);
  signed.push({ refundId: s.refundId, orderId: s.orderId, txid: s.txid, hex: s.hex, feeZats: s.feeZats.toString() });
}
if (signed.length) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(signed, null, 2));
  console.log(`${signed.length} signed tx likhi gayi: ${outFile}`);
  console.log(`\nAgla: har 'hex' ko network pe BROADCAST karo (tx expire hogi block ${expiryHeight} ke baad),`);
  console.log(`phir:  npm run refunds:sent -- <refundId> <txid>`);
}
