import { existsSync, readFileSync } from "node:fs";
import { loadSignerConfig } from "../src/config.js";
import { formatZec } from "../src/money.js";
import { scriptPubKeyToAddress } from "../src/zcash/address.js";
import { hexToBytes } from "../src/zcash/bytes.js";
import { parseTx, txidDisplayToInternal as _u, txidDigest, txidInternalToDisplay } from "../src/zcash/tx.js";

// Broadcast se pehle signed tx ko apni aankh se check karo.
// usage: npm run tx:inspect -- <hex>   ya   npm run tx:inspect -- data/signed-refunds.json
void _u;
const cfg = loadSignerConfig();
const a = process.argv[2];
if (!a) {
  console.error("Usage: npm run tx:inspect -- <hex | signed-refunds.json>");
  process.exit(1);
}
const hexes: { label: string; hex: string }[] = existsSync(a)
  ? (JSON.parse(readFileSync(a, "utf8")) as any[]).map((x) => ({ label: `refund#${x.refundId}`, hex: x.hex }))
  : [{ label: "tx", hex: a }];

for (const { label, hex } of hexes) {
  const t = parseTx(hexToBytes(hex));
  const shieldedEmpty = t.rest.length === 3 && t.rest.every((b) => b === 0);
  const unsigned = t.ins.map((i) => ({ ...i, scriptSig: new Uint8Array(0) }));
  console.log(`\n${label}: txid=${txidInternalToDisplay(txidDigest(t, unsigned, t.outs))}`);
  console.log(`  branch-id=0x${t.branchId.toString(16)} expiry-height=${t.expiryHeight} shielded-bundles=${shieldedEmpty ? "koi nahi" : "HAIN (unexpected!)"}`);
  for (const i of t.ins) console.log(`  IN   ${txidInternalToDisplay(i.prevTxid)}:${i.vout}`);
  for (const o of t.outs) console.log(`  OUT  ${formatZec(o.valueZats).padStart(12)} ZEC -> ${scriptPubKeyToAddress(o.scriptPubKey, cfg.network) ?? "(non-P2PKH script)"}`);
}
