import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/index.js";
import { parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";
import { createOrder } from "../src/services/orders.js";
import { mintPaidOrders } from "../src/services/mint.js";
import { planRefunds, planToJson, type RefundPlanItem } from "../src/services/refunds.js";
import { scanOnce } from "../src/watcher/scan.js";
import {
  accountXpubFromMnemonic, addressToScriptPubKey, deriveReceiveAddress, derivePayPrivateKey, scriptPubKeyToAddress,
} from "../src/zcash/address.js";
import { bytesToHex, hexToBytes } from "../src/zcash/bytes.js";
import {
  assertMnemonicMatchesXpub, parsePlanJson, signRefund, validatePlan, type SignParams,
} from "../src/zcash/signer.js";
import { p2pkhScript, hash160, parseTx, verifySignedTx, type SpentOutput } from "../src/zcash/tx.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import type { ChainClient, ReceivedOutput } from "../src/chain/types.js";
import { createHash } from "node:crypto";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const xpub = accountXpubFromMnemonic(M);
const buyerAddr = (i: number) => deriveReceiveAddress(xpub, 1000 + i, "testnet");
const TREASURY = deriveReceiveAddress(xpub, 2000, "testnet");
const P: SignParams = { network: "testnet", branchId: 0xc8e71055, expiryHeight: 3_000_200, treasuryAddress: TREASURY, maxFeeZats: 100_000n };
const T = (n: string) => createHash("sha256").update(n).digest("hex"); // 64-hex fake txids

function plan(over: Partial<RefundPlanItem> = {}): RefundPlanItem {
  return {
    refundId: 1,
    orderId: "order-1",
    toAddress: buyerAddr(1),
    grossZats: parseZec("0.5"),
    feeZats: 10_000n,
    inputs: [{ txid: T("a"), vout: 0, amountZats: parseZec("1.5"), addressIndex: 7 }],
    outputs: [
      { address: buyerAddr(1), amountZats: parseZec("0.5") - 10_000n, role: "refund" },
      { address: TREASURY, amountZats: parseZec("1"), role: "change" },
    ],
    ...over,
  };
}

test("sign: valid tx, independent verify pass, outputs plan jaise", () => {
  const s = signRefund(plan(), M, P);
  const bytes = hexToBytes(s.hex);
  const spent: SpentOutput[] = [{
    amountZats: parseZec("1.5"),
    scriptPubKey: p2pkhScript(hash160(secp256k1.getPublicKey(derivePayPrivateKey(M, 7), true))),
  }];
  const v = verifySignedTx(bytes, spent);
  assert.equal(v.txid, s.txid);
  assert.equal(v.feeZats, 10_000n);
  assert.equal(v.branchId, P.branchId);
  assert.equal(v.expiryHeight, P.expiryHeight);
  const t = parseTx(bytes);
  assert.equal(scriptPubKeyToAddress(t.outs[0].scriptPubKey, "testnet"), buyerAddr(1));
  assert.equal(scriptPubKeyToAddress(t.outs[1].scriptPubKey, "testnet"), TREASURY);
  assert.equal(t.outs[0].valueZats, parseZec("0.5") - 10_000n);
});

test("sign deterministic hai, aur txid signature pe depend nahi karta", () => {
  const a = signRefund(plan(), M, P);
  const b = signRefund(plan(), M, P);
  assert.equal(a.hex, b.hex);
  assert.equal(a.txid, b.txid);
  // alag expiry => alag txid
  const c = signRefund(plan(), M, { ...P, expiryHeight: P.expiryHeight + 1 });
  assert.notEqual(c.txid, a.txid);
});

test("multi-input (alag alag address index) sign hote hain", () => {
  const item = plan({
    inputs: [
      { txid: T("a"), vout: 0, amountZats: parseZec("1"), addressIndex: 3 },
      { txid: T("b"), vout: 1, amountZats: parseZec("0.7"), addressIndex: 9 },
    ],
    grossZats: parseZec("0.7"),
    feeZats: 10_000n,
    outputs: [
      { address: buyerAddr(1), amountZats: parseZec("0.7") - 10_000n, role: "refund" },
      { address: TREASURY, amountZats: parseZec("1"), role: "change" },
    ],
  });
  const s = signRefund(item, M, P);
  const spent: SpentOutput[] = [3, 9].map((idx, k) => ({
    amountZats: item.inputs[k].amountZats,
    scriptPubKey: p2pkhScript(hash160(secp256k1.getPublicKey(derivePayPrivateKey(M, idx), true))),
  }));
  assert.equal(verifySignedTx(hexToBytes(s.hex), spent).txid, s.txid);
});

test("signed tx mein ek byte badalo => verify FAIL", () => {
  const s = signRefund(plan(), M, P);
  const spent: SpentOutput[] = [{
    amountZats: parseZec("1.5"),
    scriptPubKey: p2pkhScript(hash160(secp256k1.getPublicKey(derivePayPrivateKey(M, 7), true))),
  }];
  const t = parseTx(hexToBytes(s.hex));
  // output amount badalna (hacker refund badhana chahe)
  const bytes = hexToBytes(s.hex);
  const bad = Uint8Array.from(bytes);
  // last output ke value ka pehla byte dhundh ke flip: outs ke baad 3 zero bytes hain, script 25 bytes, value 8 bytes
  const idx = bad.length - 3 - 25 - 1 - 8;
  bad[idx] ^= 0x01;
  assert.throws(() => verifySignedTx(bad, spent), /INVALID|outputs/);
  assert.ok(t.outs.length === 2);
  // galat amount (spent) => signature invalid
  assert.throws(() => verifySignedTx(bytes, [{ ...spent[0], amountZats: spent[0].amountZats + 1n }]), /INVALID/);
});

// ---------- safety: tampered/ajeeb plans REJECT ----------
const rejects = (item: RefundPlanItem, re: RegExp, p: SignParams = P) => assert.throws(() => signRefund(item, M, p), re);

test("change address treasury se alag => reject (plan tampering)", () => {
  const item = plan();
  item.outputs[1] = { ...item.outputs[1], address: buyerAddr(99) };
  rejects(item, /TREASURY_ADDRESS/);
});
test("change hai par treasury configured nahi => reject", () => rejects(plan(), /TREASURY_ADDRESS/, { ...P, treasuryAddress: undefined }));
test("inputs != outputs + fee => reject (paisa gayab/naya)", () => {
  const item = plan();
  item.outputs[1] = { ...item.outputs[1], amountZats: item.outputs[1].amountZats - 1n };
  rejects(item, /BALANCE/);
  const item2 = plan({ feeZats: 20_000n });
  rejects(item2, /BALANCE/);
});
test("fee cap se zyada => reject", () => {
  const big = plan({ feeZats: 200_000n });
  big.outputs[0] = { ...big.outputs[0], amountZats: big.outputs[0].amountZats - 190_000n };
  rejects(big, /fee .* limit/);
});
test("buyer ko gross se zyada => reject", () => rejects(plan({ grossZats: parseZec("0.1") }), /gross/));
test("refund output ka address toAddress se alag => reject", () => {
  const item = plan();
  item.outputs[0] = { ...item.outputs[0], address: buyerAddr(50) };
  rejects(item, /toAddress/);
});
test("galat network ka address => reject", () => {
  const item = plan();
  item.outputs[0] = { ...item.outputs[0], address: deriveReceiveAddress(xpub, 1, "mainnet") };
  item.toAddress = item.outputs[0].address;
  rejects(item, /valid nahi/);
});
test("duplicate input, zero input, bura txid => reject", () => {
  const i0 = plan().inputs[0];
  rejects(plan({ inputs: [i0, i0], feeZats: 10_000n }), /duplicate|BALANCE/);
  rejects(plan({ inputs: [] }), /inputs ki ginti/);
  rejects(plan({ inputs: [{ ...i0, txid: "xyz" }] }), /txid/);
});
test("outputs structure galat (2 refund / 0 refund) => reject", () => {
  const item = plan();
  item.outputs[1] = { ...item.outputs[1], role: "refund" };
  rejects(item, /exactly 1/);
  rejects(plan({ outputs: [{ address: TREASURY, amountZats: parseZec("1.49"), role: "change" }], feeZats: 10_000n }), /exactly 1/);
});
test("galat mnemonic: valid words par alag wallet => key match nahi karti / xpub mismatch", () => {
  const other = "legal winner thank year wave sausage worth useful legal winner thank yellow";
  assert.throws(() => assertMnemonicMatchesXpub(other, xpub), /match nahi/);
  assert.throws(() => assertMnemonicMatchesXpub("not a real mnemonic", xpub), /valid nahi/);
  assert.doesNotThrow(() => assertMnemonicMatchesXpub(M, xpub));
  assert.throws(() => signRefund(plan(), "abandon abandon", P), /mnemonic/);
});

test("plan JSON roundtrip + kharab JSON reject", () => {
  const item = plan();
  const back = parsePlanJson(planToJson([item]));
  assert.equal(planToJson(back), planToJson([item]));
  assert.throws(() => parsePlanJson("not json"), /JSON/);
  assert.throws(() => parsePlanJson("{}"), /array/);
  assert.throws(() => parsePlanJson(JSON.stringify([{ ...JSON.parse(planToJson([item]))[0], feeZats: "-5" }])), /zats/);
  assert.throws(() => parsePlanJson(JSON.stringify([{ ...JSON.parse(planToJson([item]))[0], inputs: "x" }])), /array/);
});

test("address <-> scriptPubKey roundtrip", () => {
  for (const net of ["testnet", "mainnet"] as const) {
    const a = deriveReceiveAddress(xpub, 5, net);
    assert.equal(scriptPubKeyToAddress(addressToScriptPubKey(a, net), net), a);
  }
  assert.throws(() => addressToScriptPubKey(deriveReceiveAddress(xpub, 5, "mainnet"), "testnet"));
  assert.throws(() => addressToScriptPubKey("garbage", "testnet"));
});

test("validatePlan sahi plan par khamosh", () => assert.doesNotThrow(() => validatePlan(plan(), P)));

// ---------- END TO END: order -> payment -> mint -> refund plan -> file -> SIGN -> verify ----------
class HexChain implements ChainClient {
  outs = new Map<string, ReceivedOutput[]>();
  n = 0;
  pay(addr: string, zec: string, conf = 10) {
    const l = this.outs.get(addr) ?? [];
    l.push({ txid: T("tx" + ++this.n), vout: 0, amountZats: parseZec(zec), confirmations: conf });
    this.outs.set(addr, l);
  }
  async getReceived(a: string) {
    return (this.outs.get(a) ?? []).map((o) => ({ ...o }));
  }
}

test("end-to-end: DB refund plan -> JSON file -> sign -> independent verify (asli order ke address se)", async () => {
  const db = await openDb();
  await createCollection(db, { slug: "demo", name: "Demo", supply: 5, priceZats: parseZec("1"), maxPerWallet: 5 });
  const T0 = new Date("2026-01-01T00:00:00Z");
  const o = await createOrder(db, { network: "testnet", walletXpub: xpub, orderTtlMinutes: 30 }, {
    collectionSlug: "demo", quantity: 1, buyerAddress: buyerAddr(1), now: T0,
  });
  const chain = new HexChain();
  chain.pay(o.payAddress, "1.5");
  await scanOnce(db, chain, { minConfirmations: 10, lateGraceHours: 168 }, new Date(T0.getTime() + 5 * 60_000));
  await mintPaidOrders(db);
  const r = await planRefunds(db, {
    network: "testnet", treasuryAddress: TREASURY, minRefundNetZats: 10_000n, minConfirmations: 10,
    feeMarginalZats: 5000n, feeGraceActions: 2,
  });
  assert.equal(r.created.length, 1);

  // file ke raaste (jaise asli flow mein): JSON -> parse -> sign
  const items = parsePlanJson(planToJson(r.created));
  const s = signRefund(items[0], M, P);

  // payment address ki key: order ka addressIndex
  const spent: SpentOutput[] = [{
    amountZats: parseZec("1.5"),
    scriptPubKey: addressToScriptPubKey(o.payAddress, "testnet"),
  }];
  const v = verifySignedTx(hexToBytes(s.hex), spent);
  assert.equal(v.feeZats, 10_000n);
  assert.equal(scriptPubKeyToAddress(v.outs[0].scriptPubKey, "testnet"), buyerAddr(1));
  assert.equal(v.outs[0].valueZats, parseZec("0.5") - 10_000n);
  assert.equal(v.outs[1].valueZats, parseZec("1"));
  assert.equal(bytesToHex(v.outs[1].scriptPubKey), bytesToHex(addressToScriptPubKey(TREASURY, "testnet")));
});
