import { sha256 } from "@noble/hashes/sha256";
import { Reader, reversed } from "./bytes.js";
import { shieldedDigestsFromRest, shieldedDigestsV6FromRest } from "./shielded-digests.js";
import { parseTx, TX_HEADER_V5, TX_HEADER_V6, txidDigest, txidDigestV6, txidInternalToDisplay, type TxOut } from "./tx.js";

export interface DecodedRawTx {
  /** Display order (explorer wala) txid, 64 hex */
  txid: string;
  /**
   * Sirf v6 mein kabhi-kabhi: jab spec mein ambiguity ho, tab doosre sambhaavit txids.
   * Server se cross-verify karke sahi wala chuna jaata hai.
   */
  txidAlternatives: string[];
  version: 4 | 5 | 6;
  /** 0 = expiry nahi. Refund tracker ko chahiye (expire hone ke baad tx kabhi mine nahi ho sakti). */
  expiryHeight: number;
  outputs: (TxOut & { vout: number })[];
}

const HEADER_V4 = 0x80000004; // overwintered | version 4 (Sapling)

/**
 * Blockchain se aayi kisi bhi raw transaction ka txid aur transparent outputs nikalta hai.
 *  - v5 (ZIP 225): txid = ZIP 244 digest. Shielded hissa ho (Noir ka deshielding payment) tab bhi chalta hai.
 *    ZIP 244 official test vectors se verified.
 *  - v4 (Sapling): txid = SHA256d(poori tx). Standard definition; iske liye official vector test nahi hai.
 *  - v6 (ZIP 229, NU6.3 Ironwood): ZIP 229 Draft hai, official vectors nahi. Txid server se cross-verify hota hai.
 *  - Koi aur version => THROW. (Chupchaap skip karne se payment chhoot sakti hai.)
 */
export function decodeRawTx(bytes: Uint8Array): DecodedRawTx {
  if (bytes.length < 8) throw new Error("raw tx bahut chhoti hai");
  const header = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);

  if (header === TX_HEADER_V5) {
    const t = parseTx(bytes);
    const unsigned = t.ins.map((i) => ({ ...i, scriptSig: new Uint8Array(0) }));
    const txid = txidInternalToDisplay(txidDigest(t, unsigned, t.outs, shieldedDigestsFromRest(t.rest)));
    return { txid, txidAlternatives: [], version: 5, expiryHeight: t.expiryHeight, outputs: t.outs.map((o, vout) => ({ ...o, vout })) };
  }

  if (header === TX_HEADER_V6) {
    const t = parseTx(bytes, 6);
    const unsigned = t.ins.map((i) => ({ ...i, scriptSig: new Uint8Array(0) }));
    const sh = shieldedDigestsV6FromRest(t.rest);
    const primary = txidInternalToDisplay(txidDigestV6(t, unsigned, t.outs, sh));
    const alternatives: string[] = [];
    if (sh.orchardEmpty) {
      // Khaali Orchard component ki personalization par spec mein halka sa shak: alternate bhi nikaal lo
      alternatives.push(txidInternalToDisplay(txidDigestV6(t, unsigned, t.outs, { ...sh, orchard: sh.orchardAlt })));
    }
    return { txid: primary, txidAlternatives: alternatives, version: 6, expiryHeight: t.expiryHeight, outputs: t.outs.map((o, vout) => ({ ...o, vout })) };
  }

  if (header === HEADER_V4) {
    const r = new Reader(bytes);
    r.u32(); // header
    r.u32(); // version group id
    const nIn = r.compact();
    for (let i = 0; i < nIn; i++) {
      r.take(36);
      r.take(r.compact());
      r.u32();
    }
    const nOut = r.compact();
    const outputs: DecodedRawTx["outputs"] = [];
    for (let vout = 0; vout < nOut; vout++) {
      const valueZats = r.i64();
      const scriptPubKey = Uint8Array.from(r.take(r.compact()));
      outputs.push({ valueZats, scriptPubKey, vout });
    }
    r.u32(); // lock_time
    const expiryHeight = r.u32();
    return { txid: Buffer.from(reversed(sha256(sha256(bytes)))).toString("hex"), txidAlternatives: [], version: 4, expiryHeight, outputs };
  }

  throw new Error(`unsupported tx header 0x${header.toString(16)} (sirf v4, v5, v6 samajhte hain)`);
}
