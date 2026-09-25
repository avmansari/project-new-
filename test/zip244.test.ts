import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bytesToHex, concat, hexToBytes } from "../src/zcash/bytes.js";
import { parseTx, serializeTx, sigHashAll, txidDigest, type SpentOutput } from "../src/zcash/tx.js";
import { shieldedDigestsFromRest } from "./helpers/zip244-shielded.js";

/**
 * Zcash ke OFFICIAL ZIP 244 test vectors (zcash/zcash-test-vectors, zip_0244.json).
 * Har vector mein: tx bytes, txid, amounts, script_pubkeys, aur sighash_all.
 */
const raw = JSON.parse(readFileSync(new URL("./vectors/zip_0244.json", import.meta.url), "utf8")) as any[];
const vectors = raw.slice(2);

test("vectors load hue (10 expected)", () => {
  assert.equal(vectors.length, 10);
});

vectors.forEach((v, k) => {
  const [txHex, txidHex, , amounts, scriptPubkeys, transparentInput, , sighashAll] = v as [
    string, string, string, number[], string[], number | null, string, string
  ];

  test(`vector #${k}: txid digest official se match`, () => {
    const tx = parseTx(hexToBytes(txHex));
    const sh = shieldedDigestsFromRest(tx.rest);
    const got = bytesToHex(txidDigest(tx, tx.ins, tx.outs, sh));
    assert.equal(got, txidHex);
  });

  test(`vector #${k}: transparent bundle serialization bilkul wahi bytes deti hai`, () => {
    const bytes = hexToBytes(txHex);
    const tx = parseTx(bytes);
    // hamari serialize() shielded hissa khaali likhti hai, isliye sirf transparent prefix compare karo
    const ours = serializeTx(tx, tx.ins, tx.outs);
    const prefixLen = ours.length - 3;
    assert.equal(bytesToHex(ours.subarray(0, prefixLen)), bytesToHex(bytes.subarray(0, prefixLen)));
  });

  if (transparentInput !== null && transparentInput !== undefined) {
    test(`vector #${k}: SIGHASH_ALL (input ${transparentInput}) official se match`, () => {
      const tx = parseTx(hexToBytes(txHex));
      const sh = shieldedDigestsFromRest(tx.rest);
      const spent: SpentOutput[] = tx.ins.map((_, i) => ({
        amountZats: BigInt(amounts[i]),
        scriptPubKey: hexToBytes(scriptPubkeys[i]),
      }));
      const unsigned = tx.ins.map((i) => ({ ...i, scriptSig: new Uint8Array(0) }));
      const got = bytesToHex(sigHashAll(tx, unsigned, tx.outs, transparentInput, spent, sh));
      assert.equal(got, sighashAll);
    });
  }
});

void concat;

// ---- negative checks: test itna tez nahi ki har cheez pass kar de ----
test("vectors se: amount/branch/expiry badalne pe digest badalta hai", () => {
  const [txHex, , , amounts, scriptPubkeys, ti] = vectors[3] as [string, string, string, number[], string[], number];
  const tx = parseTx(hexToBytes(txHex));
  const sh = shieldedDigestsFromRest(tx.rest);
  const spent: SpentOutput[] = tx.ins.map((_, i) => ({ amountZats: BigInt(amounts[i]), scriptPubKey: hexToBytes(scriptPubkeys[i]) }));
  const unsigned = tx.ins.map((i) => ({ ...i, scriptSig: new Uint8Array(0) }));
  const base = bytesToHex(sigHashAll(tx, unsigned, tx.outs, ti, spent, sh));
  const tampered = spent.map((s, i) => (i === 0 ? { ...s, amountZats: s.amountZats + 1n } : s));
  assert.notEqual(bytesToHex(sigHashAll(tx, unsigned, tx.outs, ti, tampered, sh)), base);
  assert.notEqual(bytesToHex(sigHashAll({ ...tx, branchId: tx.branchId + 1 }, unsigned, tx.outs, ti, spent, sh)), base);
  assert.notEqual(bytesToHex(sigHashAll({ ...tx, expiryHeight: tx.expiryHeight + 1 }, unsigned, tx.outs, ti, spent, sh)), base);
  const outs2 = tx.outs.map((o, i) => (i === 0 ? { ...o, valueZats: o.valueZats + 1n } : o));
  assert.notEqual(bytesToHex(sigHashAll(tx, unsigned, outs2, ti, spent, sh)), base);
});
